const base = require("@playwright/test");
const path = require("path");
const { chromium } = require("playwright");

// LambdaTest capabilities
const capabilities = {
  browserName: "Chrome", // Browsers allowed: `Chrome`, `MicrosoftEdge`, `pw-chromium`, `pw-firefox` and `pw-webkit`
  browserVersion: "latest",
  "LT:Options": {
    platform: process.env.HYPEREXECUTE_PLATFORM,
    build: "Playwright HyperExecute Build",
    name: "Playwright HyperExecute Test",
    user: process.env.LT_USERNAME,
    accessKey: process.env.LT_ACCESS_KEY,
    // 'network': true,
    video: false,
    console: true,
  },
};

// Patching the capabilities dynamically according to the project name.
const modifyCapabilities = (configName, testName) => {
  let config = configName.split("@lambdatest")[0];
  let [browserName, browserVersion] = config.split(":");
  capabilities.browserName = browserName
    ? browserName
    : capabilities.browserName;
  capabilities.browserVersion = browserVersion
    ? browserVersion
    : capabilities.browserVersion;
  // capabilities['LT:Options']['platform'] = platform ? platform : capabilities['LT:Options']['platform']
  capabilities["LT:Options"]["name"] = testName;
};

const getErrorMessage = (obj, keys) =>
  keys.reduce(
    (obj, key) => (typeof obj == "object" ? obj[key] : undefined),
    obj,
  );

exports.test = base.test.extend({
  page: async ({ page, playwright }, use, testInfo) => {
    // Configure LambdaTest platform for cross-browser testing
    let fileName = testInfo.file.split(path.sep).pop();
    if (testInfo.project.name.match(/lambdatest/)) {
      modifyCapabilities(
        testInfo.project.name,
        `${testInfo.title} - ${fileName}`,
      );

      // Tighter connect timeout so a stuck CDP handshake fails fast and
      // Playwright can retry, instead of consuming the full test timeout.
      const browser = await chromium.connect({
        wsEndpoint: `wss://cdp.lambdatest.com/playwright?capabilities=${encodeURIComponent(JSON.stringify(capabilities))}`,
        timeout: 60_000,
      });

      const ltPage = await browser.newPage(testInfo.project.use);
      await use(ltPage);

      const testStatus = {
        action: "setTestStatus",
        arguments: {
          status: testInfo.status,
          remark: getErrorMessage(testInfo, ["error", "message"]),
        },
      };
      // Teardown is best-effort: a slow LambdaTest-side close shouldn't
      // fail an already-passed test.
      const withTimeout = (p, ms) =>
        Promise.race([
          p,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error(`teardown timeout after ${ms}ms`)),
              ms,
            ),
          ),
        ]);
      try {
        await withTimeout(
          ltPage.evaluate(
            () => {},
            `lambdatest_action: ${JSON.stringify(testStatus)}`,
          ),
          15_000,
        );
      } catch (e) {
        console.warn(`[lambdatest-setup] setTestStatus failed: ${e.message}`);
      }
      try {
        await withTimeout(ltPage.close(), 15_000);
      } catch (e) {
        console.warn(`[lambdatest-setup] page.close failed: ${e.message}`);
      }
      try {
        await withTimeout(browser.close(), 30_000);
      } catch (e) {
        console.warn(`[lambdatest-setup] browser.close failed: ${e.message}`);
      }
    } else {
      // Run tests in local in case of local config provided
      await use(page);
    }
  },
});
