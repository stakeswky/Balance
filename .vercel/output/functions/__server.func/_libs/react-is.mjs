import { t as __commonJSMin } from "../_runtime.mjs";
//#region node_modules/react-is/cjs/react-is.production.min.js
/**
* @license React
* react-is.production.min.js
*
* Copyright (c) Facebook, Inc. and its affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*/
var require_react_is_production_min = /* @__PURE__ */ __commonJSMin(((exports) => {
	var b = Symbol.for("react.element");
	var c = Symbol.for("react.portal");
	var d = Symbol.for("react.fragment");
	var e = Symbol.for("react.strict_mode");
	var f = Symbol.for("react.profiler");
	var g = Symbol.for("react.provider");
	var h = Symbol.for("react.context");
	var k = Symbol.for("react.server_context");
	var l = Symbol.for("react.forward_ref");
	var m = Symbol.for("react.suspense");
	var n = Symbol.for("react.suspense_list");
	var p = Symbol.for("react.memo");
	var q = Symbol.for("react.lazy");
	function v(a) {
		if ("object" === typeof a && null !== a) {
			var r = a.$$typeof;
			switch (r) {
				case b: switch (a = a.type, a) {
					case d:
					case f:
					case e:
					case m:
					case n: return a;
					default: switch (a = a && a.$$typeof, a) {
						case k:
						case h:
						case l:
						case q:
						case p:
						case g: return a;
						default: return r;
					}
				}
				case c: return r;
			}
		}
	}
	exports.isFragment = function(a) {
		return v(a) === d;
	};
}));
//#endregion
//#region node_modules/react-is/index.js
var require_react_is = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = require_react_is_production_min();
}));
//#endregion
export { require_react_is as t };
