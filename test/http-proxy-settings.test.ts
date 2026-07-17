import assert from "node:assert/strict";
import test from "node:test";
import { applyHttpProxySettings } from "../src/core/http-dispatcher.js";

function withProxyEnv(run: () => void): void {
	const prevHttp = process.env.HTTP_PROXY;
	const prevHttps = process.env.HTTPS_PROXY;
	try {
		run();
	} finally {
		if (prevHttp === undefined) delete process.env.HTTP_PROXY;
		else process.env.HTTP_PROXY = prevHttp;
		if (prevHttps === undefined) delete process.env.HTTPS_PROXY;
		else process.env.HTTPS_PROXY = prevHttps;
	}
}

test("applyHttpProxySettings ignores undefined and blank proxy", () => {
	withProxyEnv(() => {
		delete process.env.HTTP_PROXY;
		delete process.env.HTTPS_PROXY;

		applyHttpProxySettings(undefined);
		assert.equal(process.env.HTTP_PROXY, undefined);
		assert.equal(process.env.HTTPS_PROXY, undefined);

		applyHttpProxySettings("");
		assert.equal(process.env.HTTP_PROXY, undefined);
		assert.equal(process.env.HTTPS_PROXY, undefined);

		applyHttpProxySettings("   \t");
		assert.equal(process.env.HTTP_PROXY, undefined);
		assert.equal(process.env.HTTPS_PROXY, undefined);
	});
});

test("applyHttpProxySettings sets HTTP_PROXY/HTTPS_PROXY only when unset", () => {
	withProxyEnv(() => {
		delete process.env.HTTP_PROXY;
		delete process.env.HTTPS_PROXY;

		applyHttpProxySettings("http://proxy.example:8080");
		assert.equal(process.env.HTTP_PROXY, "http://proxy.example:8080");
		assert.equal(process.env.HTTPS_PROXY, "http://proxy.example:8080");
	});
});

test("applyHttpProxySettings preserves pre-existing proxy env values", () => {
	withProxyEnv(() => {
		process.env.HTTP_PROXY = "http://existing-http:1";
		process.env.HTTPS_PROXY = "http://existing-https:1";

		applyHttpProxySettings("http://new-proxy:9");
		assert.equal(process.env.HTTP_PROXY, "http://existing-http:1");
		assert.equal(process.env.HTTPS_PROXY, "http://existing-https:1");
	});
});

test("applyHttpProxySettings fills only the unset proxy env var", () => {
	withProxyEnv(() => {
		process.env.HTTP_PROXY = "http://existing-http:1";
		delete process.env.HTTPS_PROXY;

		applyHttpProxySettings("http://new-proxy:9");
		assert.equal(process.env.HTTP_PROXY, "http://existing-http:1");
		assert.equal(process.env.HTTPS_PROXY, "http://new-proxy:9");
	});
});
