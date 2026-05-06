const { devices } = require("@playwright/test");

// Playwright config to run tests on LambdaTest platform and local
const config = {
  testDir: "tests",
  testMatch: "**/*.spec.js",
  timeout: 360000,
  use: {
    viewport: null,
  },
  workers: 4,
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
    ["json", { outputFile: "playwright-report/results.json" }],
  ],
  projects: [
    {
      name: "chrome:latest@lambdatest",
      use: {
        viewport: { width: 1280, height: 720 },
        ignoreHTTPSErrors: true,
      },
    },
    {
      name: "chromium-local",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 720 },
        ignoreHTTPSErrors: true,
      },
    },
    // {
    //   name: 'MicrosoftEdge:latest@lambdatest',
    //   use: {
    //     viewport: { width: 1280, height: 720 }
    //   }
    // }
    //     {
    //   name: 'pw-chromium:latest@lambdatest',
    //   use: {
    //     viewport: { width: 1280, height: 720 }
    //   }
    // },
    // {
    //   name: 'pw-firefox:latest@lambdatest',
    //   use: {
    //     viewport: { width: 1280, height: 720 }
    //   }
    // },
    // {
    //   name: 'pw-webkit:latest@lambdatest',
    //   use: {
    //     viewport: { width: 1280, height: 720 }
    //   }
    // }
  ],
};

module.exports = config;
