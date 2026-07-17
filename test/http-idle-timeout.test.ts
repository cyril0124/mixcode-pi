import assert from "node:assert/strict";
import test from "node:test";
import {
	DEFAULT_HTTP_IDLE_TIMEOUT_MS,
	formatHttpIdleTimeoutMs,
	HTTP_IDLE_TIMEOUT_CHOICES,
	parseHttpIdleTimeoutMs,
} from "../src/core/http-dispatcher.js";

test("DEFAULT_HTTP_IDLE_TIMEOUT_MS is 5 minutes", () => {
	assert.equal(DEFAULT_HTTP_IDLE_TIMEOUT_MS, 300_000);
});

test("parseHttpIdleTimeoutMs floors numbers and accepts string numbers", () => {
	assert.equal(parseHttpIdleTimeoutMs(30_000.9), 30_000);
	assert.equal(parseHttpIdleTimeoutMs(0), 0);
	assert.equal(parseHttpIdleTimeoutMs("60000"), 60_000);
	assert.equal(parseHttpIdleTimeoutMs(" 120000 "), 120_000);
});

test("parseHttpIdleTimeoutMs maps disabled and empty/invalid inputs", () => {
	assert.equal(parseHttpIdleTimeoutMs("disabled"), 0);
	assert.equal(parseHttpIdleTimeoutMs("Disabled"), 0);
	assert.equal(parseHttpIdleTimeoutMs(""), undefined);
	assert.equal(parseHttpIdleTimeoutMs("   "), undefined);
	assert.equal(parseHttpIdleTimeoutMs(-1), undefined);
	assert.equal(parseHttpIdleTimeoutMs(Number.NaN), undefined);
	assert.equal(parseHttpIdleTimeoutMs(Number.POSITIVE_INFINITY), undefined);
	assert.equal(parseHttpIdleTimeoutMs("not-a-number"), undefined);
	assert.equal(parseHttpIdleTimeoutMs(null), undefined);
	assert.equal(parseHttpIdleTimeoutMs(undefined), undefined);
});

test("formatHttpIdleTimeoutMs matches known choices and formats unknown ms", () => {
	for (const choice of HTTP_IDLE_TIMEOUT_CHOICES) {
		assert.equal(formatHttpIdleTimeoutMs(choice.timeoutMs), choice.label);
	}
	assert.equal(formatHttpIdleTimeoutMs(45_000), "45 sec");
	assert.equal(formatHttpIdleTimeoutMs(1_500), "1.5 sec");
});
