const EDGE_VERSION = "145.0.3800.82";
const CHROMIUM_VERSION = "145.0.7049.52";

// Values match teams-for-linux's emulateMacNativeClient (macTeamsConstants.js)
// minus the Teams-only `Teams/…` UA token, which general sites should not see.
export const USER_AGENT_OVERRIDE = {
  userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_VERSION} Safari/537.36 Edg/${EDGE_VERSION}`,
  platform: "MacIntel",
  userAgentMetadata: {
    brands: [
      { brand: "Microsoft Edge", version: "145" },
      { brand: "Not/A)Brand", version: "8" },
      { brand: "Chromium", version: "145" },
    ],
    fullVersionList: [
      { brand: "Microsoft Edge", version: EDGE_VERSION },
      { brand: "Not/A)Brand", version: "8.0.0.0" },
      { brand: "Chromium", version: CHROMIUM_VERSION },
    ],
    platform: "macOS",
    platformVersion: "10.15.7",
    architecture: "x86",
    bitness: "64",
    model: "",
    mobile: false,
  },
};
