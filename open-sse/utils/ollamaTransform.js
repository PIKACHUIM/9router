// Convert OpenAI JSON or SSE responses to the corresponding Ollama format.
export async function transformToOllama(response, model) {
  if (!response.ok) return response;

  if (response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    let body;
    try {
      body = await response.clone().json();
    } catch {
      return response;
    }
    if (body.error || !body.choices?.[0]) return response;

    const choice = body.choices[0];
    const sourceMessage = choice.message || {};
    const message = { role: "assistant", content: sourceMessage.content || "" };
    if (sourceMessage.reasoning_content) message.thinking = sourceMessage.reasoning_content;
    if (sourceMessage.tool_calls?.length) {
      message.tool_calls = sourceMessage.tool_calls.map((toolCall) => {
        let args = toolCall.function?.arguments || {};
        if (typeof args === "string") {
          try { args = JSON.parse(args); } catch { args = {}; }
        }
        if (!args || typeof args !== "object" || Array.isArray(args)) args = {};
        return { function: { name: toolCall.function?.name || "", arguments: args } };
      });
    }

    const ollama = {
      model,
      created_at: new Date(body.created ? body.created * 1000 : Date.now()).toISOString(),
      message,
      done: true,
      done_reason: choice.finish_reason === "length" ? "length" : "stop",
    };
    if (body.usage) {
      ollama.prompt_eval_count = body.usage.prompt_tokens || 0;
      ollama.eval_count = body.usage.completion_tokens || 0;
    }

    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.delete("transfer-encoding");
    headers.set("Content-Type", "application/json");
    if (!headers.has("Access-Control-Allow-Origin")) headers.set("Access-Control-Allow-Origin", "*");
    return Response.json(ollama, { status: response.status, statusText: response.statusText, headers });
  }

  let buffer = "";
  let pendingToolCalls = {};
  
  const transform = new TransformStream({
    transform(chunk, controller) {
      const text = new TextDecoder().decode(chunk);
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        
        if (data === "[DONE]") {
          const ollamaEnd = JSON.stringify({ model, message: { role: "assistant", content: "" }, done: true }) + "\n";
          controller.enqueue(new TextEncoder().encode(ollamaEnd));
          return;
        }

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta || {};
          const content = delta.content || "";
          const toolCalls = delta.tool_calls;

          if (toolCalls) {
            for (const tc of toolCalls) {
              const idx = tc.index;
              if (!pendingToolCalls[idx]) {
                pendingToolCalls[idx] = { id: tc.id, function: { name: "", arguments: "" } };
              }
              if (tc.function?.name) pendingToolCalls[idx].function.name += tc.function.name;
              if (tc.function?.arguments) pendingToolCalls[idx].function.arguments += tc.function.arguments;
            }
          }

          if (content) {
            const ollama = JSON.stringify({ model, message: { role: "assistant", content }, done: false }) + "\n";
            controller.enqueue(new TextEncoder().encode(ollama));
          }

          const finishReason = parsed.choices?.[0]?.finish_reason;
          if (finishReason === "tool_calls" || finishReason === "stop") {
            const toolCallsArr = Object.values(pendingToolCalls);
            if (toolCallsArr.length > 0) {
              const formattedCalls = toolCallsArr.map(tc => ({
                function: {
                  name: tc.function.name,
                  arguments: (() => { try { return JSON.parse(tc.function.arguments || "{}"); } catch { return {}; } })()
                }
              }));
              const ollama = JSON.stringify({ 
                model, 
                message: { role: "assistant", content: "", tool_calls: formattedCalls }, 
                done: true
              }) + "\n";
              controller.enqueue(new TextEncoder().encode(ollama));
              pendingToolCalls = {};
            } else if (finishReason === "stop") {
              const ollamaEnd = JSON.stringify({ model, message: { role: "assistant", content: "" }, done: true }) + "\n";
              controller.enqueue(new TextEncoder().encode(ollamaEnd));
            }
          }
        } catch (e) {
          // Silently ignore parse errors
        }
      }
    },
    flush(controller) {
      const ollamaEnd = JSON.stringify({ model, message: { role: "assistant", content: "" }, done: true }) + "\n";
      controller.enqueue(new TextEncoder().encode(ollamaEnd));
    }
  });

  if (!response.body) {
    return new Response("", { status: response.status, headers: { "Content-Type": "application/x-ndjson" } });
  }
  return new Response(response.body.pipeThrough(transform), {
    headers: { "Content-Type": "application/x-ndjson", "Access-Control-Allow-Origin": "*" }
  });
}

