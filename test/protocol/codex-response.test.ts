import { describe, expect, test } from "bun:test";
import type { CanonicalEvent } from "../../src/protocol/canonical-model";
import { CodexStreamFrameProcessor } from "../../src/protocol/response/codex";
import { ChatStreamEncoder, jsonCompletion } from "../../src/transport/surface/chat/encode";

test("Codex final-only tool survives Chat Completions encoding", () => {
  const processor = new CodexStreamFrameProcessor(1);
  const item = { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: '{"q":1}' };
  const events = [
    ...processor.process({ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } }),
    ...processor.process({ type: "response.output_item.done", output_index: 0, item }),
  ];
  expect(events.filter((event) => event.type === "tool_call_delta")).not.toHaveLength(0);
  expect(JSON.stringify(jsonCompletion(events, {}, "codex", "test", 0))).toContain("lookup");
});

for (const mode of ["terminal", "item", "arguments", "late-name", "streamed"] as const) {
  test(`Codex tool payload survives ${mode} frames without duplicated arguments`, () => {
    const processor = new CodexStreamFrameProcessor(1);
    const item = { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: '{"q":1}' };
    const events: CanonicalEvent[] = [];
    if (mode !== "terminal" && mode !== "item") {
      events.push(...processor.process({ type: "response.output_item.added", output_index: 0,
        item: { ...item, arguments: "", ...(mode === "late-name" ? { name: undefined } : {}) } }));
      if (mode === "streamed" || mode === "late-name") {
        events.push(...processor.process({ type: "response.function_call_arguments.delta", item_id: item.id,
          output_index: 0, delta: item.arguments }));
      }
      events.push(...processor.process({ type: "response.function_call_arguments.done", item_id: item.id,
        output_index: 0, arguments: item.arguments }));
    }
    if (mode !== "terminal") events.push(...processor.process({ type: "response.output_item.done", output_index: 0, item }));
    events.push(...processor.process({ type: "response.completed", response: { status: "completed", output: [item] } }));
    const tools = events.filter((event) => event.type === "tool_call_delta");
    expect(tools.map((event) => event.arguments_delta ?? "").join("")).toBe(item.arguments);
    expect(tools.every((event) => event.name === "lookup" && event.call_id === "call_1")).toBe(true);
    const result = jsonCompletion(events, {}, "codex", "test", 0);
    expect(JSON.stringify(result)).toContain("lookup");
  });
}

type WireTool = { id: string; function: { name: string; arguments: string } };

function expectChatTools(frames: Record<string, unknown>[], expected: WireTool[]): void {
  const processor = new CodexStreamFrameProcessor(1);
  const encoder = new ChatStreamEncoder({}, "codex", "test", 0);
  const events: CanonicalEvent[] = [];
  const chunks: Record<string, unknown>[] = [];
  for (const frame of frames) {
    for (const event of processor.process(frame)) {
      events.push(event);
      chunks.push(...encoder.push(event));
    }
  }
  const terminal = processor.terminalEvent();
  events.push(terminal);
  chunks.push(...encoder.push(terminal));
  const completion = jsonCompletion(events, {}, "codex", "test", 0);
  const choices = completion.choices as { message: { tool_calls: WireTool[] }; finish_reason: string }[];
  expect(choices[0]?.message.tool_calls).toEqual(expected.map((tool) => ({ ...tool, type: "function" })));
  expect(choices[0]?.finish_reason).toBe("tool_calls");
  const streamed = new Map<number, WireTool>();
  for (const chunk of chunks) {
    const choices = chunk.choices as { delta: { tool_calls?: (WireTool & { index: number })[] } }[];
    for (const tool of choices[0]?.delta.tool_calls ?? []) {
      const previous = streamed.get(tool.index);
      streamed.set(tool.index, {
        id: tool.id ?? previous?.id ?? "",
        function: {
          name: tool.function.name ?? previous?.function.name ?? "",
          arguments: (previous?.function.arguments ?? "") + (tool.function.arguments ?? ""),
        },
      });
    }
  }
  expect([...streamed.values()]).toEqual(expected);
}

describe("Codex tool calls through Chat encoders", () => {
  for (const type of ["function_call", "custom_tool_call"]) {
    const field = type === "function_call" ? "arguments" : "input";
    const prefix = type === "function_call" ? "function_call_arguments" : "custom_tool_call_input";
    const item = { type, id: "item-a", call_id: "call-a", name: "lookup", [field]: '{"q":1}' };
    const expected = [{ id: "call-a", function: { name: "lookup", arguments: '{"q":1}' } }];
    const terminal = { type: "response.completed", response: { status: "completed", output: [item] } };
    for (const source of ["arguments.done", "item.done", "terminal"]) {
      test(`${type} recovers full input from ${source} without deltas`, () => {
        expectChatTools([
          { type: "response.output_item.added", output_index: 0, item: { ...item, [field]: "" } },
          ...(source === "arguments.done" ? [{ type: `response.${prefix}.done`, item_id: item.id, [field]: item[field] }] : []),
          ...(source === "item.done" ? [{ type: "response.output_item.done", output_index: 0, item }] : []),
          terminal,
        ], expected);
      });
    }
    test(`${type} does not replay streamed arguments at any done boundary`, () => {
      expectChatTools([
        { type: "response.output_item.added", output_index: 0, item: { ...item, [field]: "" } },
        { type: `response.${prefix}.delta`, output_index: 0, delta: '{"q":' },
        { type: `response.${prefix}.delta`, item_id: item.id, delta: "1}" },
        { type: `response.${prefix}.done`, output_index: 0, [field]: item[field] },
        { type: "response.output_item.done", output_index: 0, item },
        terminal, terminal,
      ], expected);
    });
    test(`${type} buffers unnamed parallel deltas until late identities arrive`, () => {
      const other = { ...item, id: "item-b", call_id: "call-b", name: "other", [field]: '{"b":2}' };
      expectChatTools([
        { type: `response.${prefix}.delta`, item_id: item.id, output_index: 0, delta: '{"q":1}' },
        { type: `response.${prefix}.delta`, output_index: 1, delta: '{"b":2}' },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.output_item.done", output_index: 1, item: other },
        { type: "response.completed", response: { status: "completed", output: [item, other] } },
      ], [...expected, { id: "call-b", function: { name: "other", arguments: '{"b":2}' } }]);
    });
  }
  test("recovers terminal-only function, custom and computer calls", () => {
    expectChatTools([{ type: "response.done", response: { status: "completed", output: [
      { type: "function_call", id: "f", call_id: "call-f", name: "lookup", arguments: "{}" },
      { type: "custom_tool_call", id: "c", call_id: "call-c", name: "shell", input: "echo hello" },
      { type: "computer_call", id: "p", call_id: "call-p", action: { type: "click" } },
    ] } }], [
      { id: "call-f", function: { name: "lookup", arguments: "{}" } },
      { id: "call-c", function: { name: "shell", arguments: "echo hello" } },
      { id: "call-p", function: { name: "computer", arguments: '{"type":"click"}' } },
    ]);
  });
});

function textDeltas(events: readonly CanonicalEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === "content_delta" && event.content.kind === "text"
      ? [event.content.text]
      : [],
  );
}

describe("Codex Responses stream text", () => {
  for (const type of ["response.completed", "response.done"]) {
    test(`recovers message text from terminal-only ${type}`, () => {
      const processor = new CodexStreamFrameProcessor(5);
      const events = processor.process({
        type,
        response: {
          status: "completed",
          usage: { input_tokens: 3, output_tokens: 4 },
          end_turn: false,
          output: [
            { type: "reasoning", summary: "Do not replay reasoning." },
            null,
            [],
            { type: "message", content: null },
            {
              type: "message",
              id: "message-1",
              content: [
                null,
                { type: "refusal", refusal: "Not output text." },
                { type: "output_text", text: 42 },
                { type: "output_text", text: "" },
                { type: "output_text", text: "First part." },
                { type: "output_text", text: "Second part." },
              ],
            },
            { type: "message", content: [{ type: "output_text", text: "Another message." }] },
          ],
        },
      });

      expect(textDeltas(events)).toEqual(["First part.", "Second part.", "Another message."]);
      expect(events.map((event) => event.type)).toEqual([
        "content_delta", "content_delta", "content_delta",
      ]);
      expect(events.map((event) => event.sequence_number)).toEqual([5, 6, 7]);
      expect(processor.hasToolCall).toBe(false);
      expect(processor.isDone).toBe(true);
      expect(processor.terminalStatus).toBe("completed");
      expect(processor.terminalUsage).toEqual({ input_tokens: 3, output_tokens: 4 });
      expect(processor.terminalEndTurn).toBe(false);
      expect(processor.terminalEvent()).toMatchObject({ sequence_number: 8, stop_reason: "pause_turn" });
    });

    for (const earlierType of [
      "response.output_text.delta",
      "response.output_text.done",
      "response.output_item.done",
    ]) {
      for (const identity of ["item", "output"]) {
        test(`${type} deduplicates ${earlierType} by ${identity} identity`, () => {
          const processor = new CodexStreamFrameProcessor(1);
          const text = "Already delivered.";
          const item = {
            type: "message",
            ...(identity === "item" ? { id: "message-1" } : {}),
            content: [{ type: "output_text", text }],
          };
          const earlier = processor.process({
            type: earlierType,
            ...(identity === "item" ? { item_id: "message-1" } : { output_index: 0 }),
            content_index: 0,
            delta: text,
            text,
            item,
          });
          const terminal = {
            type,
            response: {
              status: "completed",
              output: [{
                ...item,
                id: "message-1",
                content: [...item.content, { type: "output_text", text: "Recovered block." }],
              }],
            },
          };
          const recovered = processor.process(terminal);
          expect(textDeltas([...earlier, ...recovered])).toEqual([text, "Recovered block."]);
          expect(processor.process(terminal)).toEqual([]);
          expect(processor.process({ ...terminal, type: "response.done" })).toEqual([]);
        });
      }
    }

    test(`${type} ignores malformed terminal output`, () => {
      for (const output of [undefined, null, "invalid", {}, [null, 42, [], { type: "message", content: {} }]]) {
        const processor = new CodexStreamFrameProcessor(1);
        expect(processor.process({ type, response: { status: "completed", output } })).toEqual([]);
        expect(processor.isDone).toBe(true);
      }
    });
  }

  test("recovers text from final events when no text deltas arrive", () => {
    const processor = new CodexStreamFrameProcessor(1);
    const outputText = "Reviewed the files and wrote the requested documentation.";
    const outputTextDone = processor.process({
      type: "response.output_text.done",
      item_id: "message-1",
      output_index: 0,
      content_index: 0,
      text: outputText,
    });
    const outputItemDone = processor.process({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "message-1",
        type: "message",
        content: [{ type: "output_text", text: outputText }],
      },
    });

    expect([...textDeltas(outputTextDone), ...textDeltas(outputItemDone)]).toEqual([
      outputText,
    ]);
  });

  test("recovers text when only the completed output item is sent", () => {
    const processor = new CodexStreamFrameProcessor(1);
    const events = processor.process({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "message-1",
        type: "message",
        content: [{ type: "output_text", text: "Final-only answer." }],
      },
    });

    expect(textDeltas(events)).toEqual(["Final-only answer."]);
  });

  test("appends the missing suffix when a final snapshot completes partial text deltas", () => {
    const processor = new CodexStreamFrameProcessor(1);
    const partial = "The response should end";
    const complete = "The response should end with this sentence.";
    const events = [
      ...processor.process({
        type: "response.output_text.delta",
        item_id: "message-1",
        output_index: 0,
        content_index: 0,
        delta: partial,
      }),
      ...processor.process({
        type: "response.output_text.done",
        item_id: "message-1",
        output_index: 0,
        content_index: 0,
        text: complete,
      }),
      ...processor.process({
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "message-1",
          type: "message",
          content: [{ type: "output_text", text: complete }],
        },
      }),
    ];

    expect(textDeltas(events).join("")).toBe(complete);
    expect(textDeltas(events)).toEqual([partial, complete.slice(partial.length)]);
  });

  test("does not repeat text already delivered as deltas", () => {
    const processor = new CodexStreamFrameProcessor(1);
    const outputText = "A streamed answer.";
    const delta = processor.process({
      type: "response.output_text.delta",
      item_id: "message-1",
      output_index: 0,
      content_index: 0,
      delta: outputText,
    });
    const outputTextDone = processor.process({
      type: "response.output_text.done",
      item_id: "message-1",
      output_index: 0,
      content_index: 0,
      text: outputText,
    });
    const outputItemDone = processor.process({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "message-1",
        type: "message",
        content: [{ type: "output_text", text: outputText }],
      },
    });

    expect([
      ...textDeltas(delta),
      ...textDeltas(outputTextDone),
      ...textDeltas(outputItemDone),
    ]).toEqual([outputText]);
  });
});