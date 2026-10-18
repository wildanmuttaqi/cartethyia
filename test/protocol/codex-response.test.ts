import { describe, expect, test } from "bun:test";
import type { CanonicalEvent } from "../../src/protocol/canonical-model";
import { CodexStreamFrameProcessor } from "../../src/protocol/response/codex";

function textDeltas(events: readonly CanonicalEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === "content_delta" && event.content.kind === "text"
      ? [event.content.text]
      : [],
  );
}

describe("Codex Responses stream text", () => {
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