import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ThreadStore } from "../../bridge-core/src/lib.mjs";

import {
  activeTurnBlock,
  commandAction,
  consumeUpdates,
  extractText,
  MessageItemType,
  parseBool,
  parseCommand,
  parseList,
  preservedChatStateFields,
  splitMessage
} from "../src/lib.mjs";

test("extractText reads text and voice transcript items", () => {
  assert.equal(
    extractText([{ type: MessageItemType.TEXT, text_item: { text: "hello" } }]),
    "hello"
  );
  assert.equal(
    extractText([{ type: MessageItemType.VOICE, voice_item: { text: "voice text" } }]),
    "voice text"
  );
});

test("shared command helpers preserve Weixin bridge command behavior", () => {
  assert.deepEqual(parseList("u1, u2 ,, "), ["u1", "u2"]);
  assert.equal(parseBool("yes"), true);
  assert.deepEqual(parseCommand("/allow ap_1 remember"), {
    name: "allow",
    args: "ap_1 remember"
  });
  assert.deepEqual(commandAction(parseCommand("/model auto")), {
    kind: "set_model",
    modelName: "auto"
  });
  assert.deepEqual(commandAction(parseCommand("/unknown value")), {
    kind: "prompt",
    prompt: "/unknown value"
  });
});

test("shared state and runtime helpers preserve Weixin bridge behavior", () => {
  assert.deepEqual(preservedChatStateFields({ model: "m", activeTurnId: "turn-1" }), {
    model: "m"
  });
  assert.deepEqual(splitMessage("a🧪b", 2), ["a🧪", "b"]);
  assert.deepEqual(activeTurnBlock({ turns: [{ id: "turn-1", status: "in_progress" }] }), {
    turnId: "turn-1",
    message: "Thread already has active turn turn-1. Wait for it to finish or send /interrupt."
  });
});

function batchHarness(msgs, overrides = {}) {
  const handled = [];
  const marked = [];
  const errors = [];
  return {
    handled,
    marked,
    errors,
    run: () =>
      consumeUpdates({
        msgs,
        keyOf: (msg) => `m${msg.id}`,
        isHandled: () => false,
        handle: async (msg) => {
          handled.push(msg.id);
        },
        markHandled: async (key) => {
          marked.push(key);
        },
        onError: (error, msg) => {
          errors.push([error.message, msg.id]);
        },
        ...overrides
      })
  };
}

test("consumeUpdates handles a batch and records each message after it succeeds", async () => {
  const harness = batchHarness([{ id: 1 }, { id: 2 }]);

  assert.deepEqual(await harness.run(), { ok: true, handledCount: 2 });
  assert.deepEqual(harness.handled, [1, 2]);
  assert.deepEqual(harness.marked, ["m1", "m2"]);
});

test("consumeUpdates stops the batch without recording when a handler fails", async () => {
  const harness = batchHarness([{ id: 1 }, { id: 2 }], {
    handle: async (msg) => {
      if (msg.id === 2) throw new Error("boom");
    }
  });

  const result = await harness.run();
  assert.equal(result.ok, false);
  assert.equal(result.error.message, "boom");
  assert.equal(result.handledCount, 1);
  // The failed message must stay unrecorded so the replay re-handles it.
  assert.deepEqual(harness.marked, ["m1"]);
  assert.deepEqual(harness.errors, [["boom", 2]]);
});

test("consumeUpdates skips already handled messages and tolerates keyless ones", async () => {
  const skipped = [];
  const replay = await consumeUpdates({
    msgs: [{ id: 1 }, { id: 2 }],
    keyOf: (msg) => `m${msg.id}`,
    isHandled: (key) => key === "m1",
    handle: async (msg) => {
      skipped.push(msg.id);
    },
    markHandled: async () => {}
  });
  assert.deepEqual(replay, { ok: true, handledCount: 1 });
  assert.deepEqual(skipped, [2]);

  const marked = [];
  const keyless = await consumeUpdates({
    msgs: [{ id: 9 }],
    keyOf: () => "",
    isHandled: () => false,
    handle: async () => {},
    markHandled: async (key) => {
      marked.push(key);
    }
  });
  assert.deepEqual(keyless, { ok: true, handledCount: 1 });
  assert.deepEqual(marked, []);

  const empty = await consumeUpdates({
    msgs: [],
    keyOf: () => "",
    isHandled: () => false,
    handle: async () => {},
    markHandled: async () => {}
  });
  assert.deepEqual(empty, { ok: true, handledCount: 0 });
});

test("a crash-replayed batch re-handles only the message that failed", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codewhale-weixin-bridge-"));
  try {
    const store = await ThreadStore.open(path.join(dir, "thread-map.json"), {
      messageLimit: 10
    });
    const msgs = [{ from_user_id: "u1", message_id: "42" }];
    let attempts = 0;

    const runBatch = () =>
      consumeUpdates({
        msgs,
        keyOf: (msg) => `${msg.from_user_id}:${msg.message_id}`,
        isHandled: (key) => store.hasMessage(key),
        handle: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("simulated crash");
        },
        markHandled: (key) => store.recordMessage(key)
      });

    assert.equal((await runBatch()).ok, false);
    assert.equal(store.hasMessage("u1:42"), false);

    // The replay re-handles it and only then records the dedupe key.
    assert.equal((await runBatch()).ok, true);
    assert.equal(store.hasMessage("u1:42"), true);
    assert.equal(attempts, 2);

    // A third delivery is deduplicated: the handler is not called again.
    assert.equal((await runBatch()).ok, true);
    assert.equal(attempts, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
