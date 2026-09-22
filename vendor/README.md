JSFeat (MIT), Eugene Zatepyakin.

Source: https://github.com/inspirit/jsfeat/tree/4c7b336bbeeb26e6cd4cdf3c7d414abe273846f3

`build/jsfeat-min.js` is vendored as `jsfeat.js`. Changes: browser global `window` is replaced with `globalThis` for Workers, and an ES module default export is appended. See JSFEAT-LICENSE.txt. No network calls or new model downloads are introduced.
