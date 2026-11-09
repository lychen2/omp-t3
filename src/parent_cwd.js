'use strict';

/** Private extension-bus query; the existing T3 client owns credentials and caller identity. */
function registerParentCwd(pi, client, ensureStarted) {
  if (!pi.events || typeof pi.events.on !== 'function') return;
  const unsubscribe = pi.events.on('omp-t3:parent-cwd:v1', async request => {
    if (request === null || typeof request !== 'object' || typeof request.reply !== 'function') return;
    try {
      await ensureStarted();
      const signal = AbortSignal.timeout(5000);
      const read = async (name, args) => {
        const result = await client.callTool(name, args, signal);
        if (!result || result.isError === true) throw new Error(`T3 ${name} could not verify thread metadata`);
        if (result.structuredContent !== undefined) return result.structuredContent;
        const text = result.content?.find(part => part.type === 'text')?.text;
        if (typeof text !== 'string') throw new Error(`T3 ${name} returned no metadata`);
        return JSON.parse(text);
      };
      // T3's capabilities field names the caller used as the parent of future delegates.
      // Actual ancestry comes from thread_read, never from this misleadingly named field.
      const capabilities = await read('orchestrator_capabilities', {});
      const ownId = capabilities?.parentThreadId;
      if (typeof ownId !== 'string' || ownId.length === 0) throw new Error('T3 caller thread is unavailable');
      const own = (await read('t3_thread_read', { threadId: ownId, limit: 1, runLimit: 1, maxCharsPerItem: 1 }))?.thread;
      if (!own || own.threadId !== ownId) throw new Error('T3 caller metadata does not match its identity');
      if (own.relationshipToParent === null || own.relationshipToParent === 'fork') {
        request.reply({ kind: 'top-level' });
        return;
      }
      if (own.relationshipToParent !== 'subagent' || typeof own.parentThreadId !== 'string' || !own.parentThreadId || own.parentThreadId === ownId) {
        throw new Error('T3 parent relationship is unavailable');
      }
      const parent = (await read('t3_thread_read', { threadId: own.parentThreadId, limit: 1, runLimit: 1, maxCharsPerItem: 1 }))?.thread;
      if (!parent || parent.threadId !== own.parentThreadId) throw new Error('T3 parent metadata does not match its identity');
      let cwd = parent.worktreePath;
      if (cwd === null && typeof parent.projectId === 'string') {
        const project = await read('t3_project_read', { projectId: parent.projectId });
        if (project?.id !== parent.projectId) throw new Error('T3 parent project does not match its identity');
        cwd = project.workspaceRoot;
      }
      if (typeof cwd !== 'string' || !cwd.startsWith('/')) throw new Error('T3 parent working directory is unavailable');
      request.reply({ kind: 'parent', cwd });
    } catch (error) {
      request.reply({ kind: 'unavailable', message: error instanceof Error ? error.message : String(error) });
    }
  });
  pi.on('session_shutdown', unsubscribe);
}

module.exports = { registerParentCwd };
