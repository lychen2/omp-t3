'use strict';

/** Extend provider-facing schemas, leaving the tool execution schemas intact. */
function installToolIntent(pi) {
  const installed = new WeakSet();
  pi.on('session_start', (_event, ctx) => {
    const ref = pi.pi.AgentRegistry.global().list().find(ref => ref.session?.sessionManager === ctx.sessionManager);
    if (!ref) throw new Error('Cannot attach T3 tool intents: caller session not found');
    const agent = ref.session.agent;
    if (installed.has(agent)) return;
    installed.add(agent);
    const stream = agent.streamFn;
    agent.streamFn = (model, context, options) => {
      const tools = context.tools?.map(tool => {
        const schema = typeof tool.parameters?.toJsonSchema === 'function'
          ? tool.parameters.toJsonSchema() : tool.parameters;
        if (!schema || schema.type !== 'object') return tool;
        return {
          ...tool,
          parameters: {
            ...schema,
            properties: {
              ...schema.properties,
              i: {
                type: 'string',
                description: "Brief purpose of this tool call for the T3 card title. Describe why you are calling the tool. Use the user's language and preserve technical identifiers."
              }
            },
            required: [...new Set([...(schema.required ?? []), 'i'])]
          }
        };
      });
      return stream(model, { ...context, tools }, options);
    };
  });
}

module.exports = { installToolIntent };
