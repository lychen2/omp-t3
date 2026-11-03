'use strict';

/**
 * Translates T3 Pi Stop/queue RPCs onto omp's queue API.
 *
 * Why this exists
 * ---------------
 * Current T3 Code Stop sends `clear_queue` and then `abort`, and renders the
 * returned `{steering, followUp}` texts while the turn is still active. Older
 * T3 sends `abort` alone. omp has neither `clear_queue` nor a plain abort that
 * preserves queued input: a plain `abort` starts the queued steering/follow-up
 * messages as the run unwinds (observed on omp 18.16.0), which executes input
 * the user asked to discard.
 *
 * omp's atomic equivalent is `abort_and_restore_queue`: it withdraws the
 * undelivered user-authored queue and aborts in one RPC, returning the
 * withdrawn entries. This adapter per Stop:
 *
 *   1. turns the first upstream Stop frame (`clear_queue` for new T3, `abort`
 *      for old T3) into exactly one `abort_and_restore_queue`,
 *   2. routes the abort through the settlement tracker so the subagent sweep
 *      and aborted settle synthesis still run,
 *   3. answers `clear_queue` from the atomic result with the original request
 *      id and verbatim text order (no get_state+remove race),
 *   4. acknowledges the later T3 `abort` locally instead of aborting twice,
 *   5. holds omp's abort-related downstream frames until T3's `abort` lands so
 *      the clear response is handled while T3's turn is still active (its
 *      queue-cleared notice reads `threadState.activeTurn`), then replays them
 *      through the normal downstream pipeline.
 *
 * The adapter never reports success it did not receive from omp: if the atomic
 * command fails, `clear_queue` gets a real failure response and the original
 * `abort` is forwarded unchanged.
 */

const RESTORE_COMMAND = 'abort_and_restore_queue';
const CLEAR_QUEUE = 'clear_queue';
const ABORT = 'abort';

/** Parses one JSON frame; non-objects and malformed lines are not ours. */
function parseFrame(line) {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Normalizes omp's restored-queue items to the string arrays T3 expects. */
function restoredTexts(value) {
  if (!Array.isArray(value)) return [];
  const texts = [];
  for (const item of value) {
    if (typeof item === 'string') {
      texts.push(item);
    } else if (item && typeof item === 'object' && typeof item.text === 'string') {
      texts.push(item.text);
    }
  }
  return texts;
}

/** Builds the T3 `clear_queue` result from omp's abort_and_restore_queue data. */
function clearQueueData(data) {
  const source = data && typeof data === 'object' ? data : {};
  return {
    steering: restoredTexts(source.steering),
    followUp: restoredTexts(source.followUp)
  };
}

/** Error text from a failed omp response, stable for T3 and tests. */
function responseError(record) {
  if (record && typeof record.error === 'string' && record.error.length > 0) {
    return record.error;
  }
  return `${RESTORE_COMMAND} failed.`;
}

class QueueCompatAdapter {
  /**
   * @param {object} options
   * @param {(line: string) => void} options.writeToOmp Writes one line to omp.
   * @param {(line: string) => void} options.writeToClient Writes one line to T3.
   * @param {(line: string) => void} options.replayDownstream Runs one buffered
   *   omp line through the rest of the downlink pipeline (must not re-enter
   *   this adapter).
   * @param {{ handleUpstreamFrame: (line: string) => ({ emit?: string } | null) }} options.settlementTracker
   *   The proxy's tracker: abort frames routed here fire the subagent sweep and
   *   the aborted settle synthesis.
   */
  constructor(options) {
    const { writeToOmp, writeToClient, replayDownstream, settlementTracker } = options || {};
    if (typeof writeToOmp !== 'function') throw new TypeError('writeToOmp must be a function');
    if (typeof writeToClient !== 'function') throw new TypeError('writeToClient must be a function');
    if (typeof replayDownstream !== 'function') {
      throw new TypeError('replayDownstream must be a function');
    }
    if (!settlementTracker || typeof settlementTracker.handleUpstreamFrame !== 'function') {
      throw new TypeError('settlementTracker.handleUpstreamFrame must be a function');
    }
    this.writeToOmp = writeToOmp;
    this.writeToClient = writeToClient;
    this.replayDownstream = replayDownstream;
    this.settlementTracker = settlementTracker;
    this.nextId = 1;
    // omp request id -> operation.
    this.operations = new Map();
    // Clear operations still waiting for T3's follow-up abort.
    this.awaitingAbort = [];
    // Operation whose downstream frames are currently held.
    this.bufferOwner = null;
  }

  /** Sends one frame plus newline to omp. */
  sendToOmp(record) {
    this.writeToOmp(JSON.stringify(record) + '\n');
  }

  /** Sends one frame plus newline to T3. */
  sendToClient(record) {
    this.writeToClient(JSON.stringify(record) + '\n');
  }

  /**
   * Starts one atomic queue-withdraw-and-abort for this Stop.
   * @param {object} operation
   * @param {string | null} settlementLine Abort-shaped frame to route through
   *   the settlement tracker, or null when it was already routed.
   * @param {boolean} bufferDownstream Whether to hold downstream frames until
   *   T3's abort arrives.
   */
  startRestore(operation, settlementLine, bufferDownstream) {
    operation.ompId = `ompt3-queue-${this.nextId++}`;
    operation.state = 'pending';
    operation.result = null;
    operation.error = null;
    operation.clearAnswered = false;
    operation.abortAnswered = false;
    operation.abortForwarded = false;
    operation.buffer = bufferDownstream ? [] : null;
    operation.bufferFlushed = false;
    this.operations.set(operation.ompId, operation);
    if (bufferDownstream) this.bufferOwner = operation;

    // The sweep and sawAbort flag must exist before omp's agent_end reaches
    // the downstream tracker; omp emits agent_end before the RPC response.
    if (settlementLine !== null) {
      const settlement = this.settlementTracker.handleUpstreamFrame(settlementLine);
      if (settlement && settlement.emit) {
        if (operation.buffer !== null) {
          operation.buffer.push({
            kind: 'client',
            line: settlement.emit.replace(/\n+$/, '')
          });
        } else {
          this.writeToClient(settlement.emit);
        }
      }
    }

    this.sendToOmp({ type: RESTORE_COMMAND, id: operation.ompId });
  }

  /**
   * Handles one T3 -> omp line.
   * @param {string} line Trimmed JSON frame.
   * @returns {{ handled: boolean }}
   */
  handleUpstreamFrame(line) {
    const frame = parseFrame(line);
    if (frame === null) return { handled: false };

    if (frame.type === CLEAR_QUEUE) {
      // A clear without a following abort would leak the buffer; release any
      // previous Stop first and start over from this one.
      if (this.bufferOwner !== null) this.flushBuffer(this.bufferOwner);

      const operation = {
        clearId: frame.id,
        abortId: undefined,
        abortLine: null
      };
      this.awaitingAbort.push(operation);
      this.startRestore(operation, JSON.stringify({ type: ABORT }), true);
      return { handled: true };
    }

    if (frame.type === ABORT) {
      const waiting = this.awaitingAbort.find((operation) => operation.abortId === undefined);
      if (waiting !== undefined) {
        waiting.abortId = frame.id;
        waiting.abortLine = line;
        if (waiting.state === 'done') {
          this.finishAbort(waiting);
        } else if (waiting.state === 'failed') {
          this.forwardFallbackAbort(waiting);
        }
        return { handled: true };
      }

      // Older T3: `abort` alone is its Stop. Route the real frame through the
      // tracker first so the sweep runs, then replace the plain abort (which
      // would drain the queue) with the atomic restore.
      const operation = {
        clearId: undefined,
        abortId: frame.id,
        abortLine: line
      };
      this.startRestore(operation, line, false);
      return { handled: true };
    }

    // A new turn proves no Stop is still in flight; never leave output held.
    if (frame.type === 'prompt' || frame.type === 'abort_and_prompt') {
      this.flushAll();
    }
    return { handled: false };
  }

  /**
   * Handles one omp -> T3 line.
   * @param {string} line Trimmed JSON frame.
   * @returns {{ handled: boolean }}
   */
  handleDownstreamFrame(line) {
    const frame = parseFrame(line);
    if (frame !== null && frame.type === 'response') {
      const operation =
        frame.id === undefined ? undefined : this.operations.get(String(frame.id));
      if (operation !== undefined) {
        this.handleRestoreResponse(operation, frame);
        return { handled: true };
      }
    }

    // Hold every frame emitted while the atomic abort unwinds: agent_end,
    // queue_update, prompt_result and session_settled must not finalize T3's
    // turn before T3 has processed the clear_queue response.
    const owner = this.bufferOwner;
    if (owner !== null && owner.buffer !== null && !owner.bufferFlushed) {
      owner.buffer.push({ kind: 'omp', line });
      return { handled: true };
    }

    return { handled: false };
  }

  /** Applies an omp response to the atomic restore operation. */
  handleRestoreResponse(operation, frame) {
    if (operation.state !== 'pending') return;

    if (frame.success === true) {
      operation.state = 'done';
      operation.result = clearQueueData(frame.data);
      this.sendClearSuccess(operation);
      if (operation.abortId !== undefined) this.finishAbort(operation);
      return;
    }

    operation.state = 'failed';
    operation.error = responseError(frame);
    if (operation.clearId !== undefined) {
      // Real failure, never a fabricated success. T3's clearNativeQueue
      // treats it as "nothing cleared" and still proceeds to abort.
      this.sendToClient({
        type: 'response',
        command: CLEAR_QUEUE,
        id: operation.clearId,
        success: false,
        error: operation.error
      });
      operation.clearAnswered = true;
      // The atomic path never aborted, so nothing downstream is held for it.
      this.flushBuffer(operation);
    }
    if (operation.abortId !== undefined) {
      this.forwardFallbackAbort(operation);
    }
  }

  /** Emits the T3 clear_queue success response with the original id. */
  sendClearSuccess(operation) {
    if (operation.clearId === undefined || operation.clearAnswered) return;
    operation.clearAnswered = true;
    this.sendToClient({
      type: 'response',
      command: CLEAR_QUEUE,
      id: operation.clearId,
      success: true,
      data: operation.result
    });
  }

  /** Completes the locally-acknowledged T3 abort after the atomic succeeded. */
  finishAbort(operation) {
    if (operation.abortId === undefined || operation.abortAnswered) return;
    if (operation.state !== 'done') return;
    // omp emits agent_end before its RPC response; release that frame (and the
    // translated settle) before acknowledging the abort, matching wire order.
    this.flushBuffer(operation);
    operation.abortAnswered = true;
    this.sendToClient({
      type: 'response',
      command: ABORT,
      id: operation.abortId,
      success: true
    });
    this.retire(operation);
  }

  /** Falls back to the original plain abort when the atomic RPC failed. */
  forwardFallbackAbort(operation) {
    if (operation.abortForwarded) return;
    operation.abortForwarded = true;
    this.flushBuffer(operation);
    this.writeToOmp(operation.abortLine);
    this.retire(operation);
  }

  /** Releases every held frame through the normal downstream pipeline. */
  flushBuffer(operation) {
    if (operation.buffer === null || operation.bufferFlushed) return;
    operation.bufferFlushed = true;
    const held = operation.buffer;
    operation.buffer = null;
    if (this.bufferOwner === operation) this.bufferOwner = null;
    for (const item of held) {
      if (item.kind === 'client') {
        this.writeToClient(item.line + '\n');
      } else {
        this.replayDownstream(item.line);
      }
    }
  }

  /** Releases held frames for every operation (used when a new turn begins). */
  flushAll() {
    for (const operation of this.operations.values()) this.flushBuffer(operation);
  }

  /** Drops an operation once T3 has been answered. */
  retire(operation) {
    this.operations.delete(operation.ompId);
    const index = this.awaitingAbort.indexOf(operation);
    if (index !== -1) this.awaitingAbort.splice(index, 1);
    if (this.bufferOwner === operation) this.bufferOwner = null;
  }
}

module.exports = {
  QueueCompatAdapter,
  clearQueueData,
  restoredTexts
};
