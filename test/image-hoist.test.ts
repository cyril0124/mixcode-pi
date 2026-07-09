import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hoistImages } from "../pi-packages/mpi-image-hoist/index.ts";

describe("image-hoist: hoistImages", () => {
  it("hoists images from tool_result to user message top level", () => {
    const payload = {
      model: "claude-opus-4-7",
      messages: [
        { role: "user", content: "read the image" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_01", name: "read", input: { path: "/tmp/img.png" } }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_01",
              content: [
                { type: "text", text: "Read image file [image/png]" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
              ],
            },
          ],
        },
      ],
    };

    const count = hoistImages(payload as any);
    assert.equal(count, 1);

    // Image should be at top level of last user message
    const lastUser = payload.messages[2];
    assert.equal(Array.isArray(lastUser.content), true);
    const content = lastUser.content as any[];
    assert.equal(content.length, 2); // tool_result + hoisted image

    // tool_result should no longer contain the image
    const tr = content[0];
    assert.equal(tr.type, "tool_result");
    assert.equal(tr.content.length, 1);
    assert.equal(tr.content[0].type, "text");

    // Hoisted image at end
    const img = content[1];
    assert.equal(img.type, "image");
    assert.equal(img.source.media_type, "image/png");
    assert.equal(img.source.data, "AAAA");
  });

  it("does nothing when no images in tool_result", () => {
    const payload = {
      model: "claude-opus-4-7",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_01",
              content: [{ type: "text", text: "file contents here" }],
            },
          ],
        },
      ],
    };

    const count = hoistImages(payload as any);
    assert.equal(count, 0);
  });

  it("does nothing when tool_result content is a string", () => {
    const payload = {
      model: "claude-opus-4-7",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_01",
              content: "plain text result",
            },
          ],
        },
      ],
    };

    const count = hoistImages(payload as any);
    assert.equal(count, 0);
  });

  it("handles multiple images in one tool_result", () => {
    const payload = {
      model: "claude-opus-4-7",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_01",
              content: [
                { type: "text", text: "Two images" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: "IMG1" } },
                { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "IMG2" } },
              ],
            },
          ],
        },
      ],
    };

    const count = hoistImages(payload as any);
    assert.equal(count, 2);

    const content = payload.messages[0].content as any[];
    assert.equal(content.length, 3); // tool_result + 2 images
    assert.equal(content[1].source.data, "IMG1");
    assert.equal(content[2].source.data, "IMG2");
  });

  it("handles multiple tool_results with images in one user message", () => {
    const payload = {
      model: "claude-opus-4-7",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_01",
              content: [
                { type: "text", text: "img 1" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: "A" } },
              ],
            },
            {
              type: "tool_result",
              tool_use_id: "toolu_02",
              content: [
                { type: "text", text: "img 2" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: "B" } },
              ],
            },
          ],
        },
      ],
    };

    const count = hoistImages(payload as any);
    assert.equal(count, 2);

    const content = payload.messages[0].content as any[];
    // 2 tool_results + 2 hoisted images
    assert.equal(content.length, 4);
    assert.equal(content[2].type, "image");
    assert.equal(content[3].type, "image");
  });

  it("only processes the last user message", () => {
    const payload = {
      model: "claude-opus-4-7",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_old",
              content: [
                { type: "text", text: "old" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: "OLD" } },
              ],
            },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "response" }] },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_new",
              content: [
                { type: "text", text: "new" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: "NEW" } },
              ],
            },
          ],
        },
      ],
    };

    const count = hoistImages(payload as any);
    assert.equal(count, 1);

    // First user message should be untouched
    const firstUser = payload.messages[0].content as any[];
    assert.equal(firstUser[0].content.length, 2); // still has image inside

    // Last user message should have image hoisted
    const lastUser = payload.messages[2].content as any[];
    assert.equal(lastUser.length, 2); // tool_result + hoisted image
    assert.equal(lastUser[1].source.data, "NEW");
  });

  it("replaces empty tool_result content with placeholder text", () => {
    const payload = {
      model: "claude-opus-4-7",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_01",
              content: [
                { type: "image", source: { type: "base64", media_type: "image/png", data: "X" } },
              ],
            },
          ],
        },
      ],
    };

    const count = hoistImages(payload as any);
    assert.equal(count, 1);

    const content = payload.messages[0].content as any[];
    const tr = content[0];
    assert.equal(tr.content.length, 1);
    assert.equal(tr.content[0].type, "text");
    assert.equal(tr.content[0].text, "(image hoisted to message level)");
  });

  it("returns 0 for empty messages array", () => {
    assert.equal(hoistImages({ model: "x", messages: [] }), 0);
  });

  it("returns 0 when no user message exists", () => {
    const payload = {
      model: "x",
      messages: [{ role: "assistant", content: [{ type: "text", text: "hi" }] }],
    };
    assert.equal(hoistImages(payload as any), 0);
  });

  it("returns 0 when user message content is a string", () => {
    const payload = {
      model: "x",
      messages: [{ role: "user", content: "hello" }],
    };
    assert.equal(hoistImages(payload as any), 0);
  });
});
