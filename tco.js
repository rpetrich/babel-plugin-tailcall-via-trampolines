function callExpressionPathIsTailCall(path) {
	const callee = path.node.callee;
	return path.parentPath.isReturnStatement();
}

function findTailCall(path) {
	let result = null;
	path.traverse({
		CallExpression: {
			enter(path) {
				if (path.node.callee.type == "Identifier" && path.node.callee.name == "__as_tail_recursive") {
					return;
				}
				let currentPath = path;
				while (currentPath.parentPath.node && (
					(currentPath.parentPath.isLogicalExpression() && currentPath.parentPath.node.right === currentPath.node) ||
					(currentPath.parentPath.isConditionalExpression() && (currentPath.parentPath.node.consequent === currentPath.node || currentPath.parentPath.node.alternate === currentPath.node))
				)) {
					currentPath = currentPath.parentPath;
				}
				if (currentPath.parentPath.isReturnStatement() || currentPath.parentPath.isArrowFunctionExpression()) {
					path.stop();
					result = path;
				}
			}
		},
		FunctionDeclaration(path) {
			path.skip();
		},
		FunctionExpression(path) {
			path.skip();
		},
		ClassMethod(path) {
			path.skip();
		},
		ObjectMethod(path) {
			path.skip();
		},
		ArrowFunctionExpression(path) {
			path.skip();
		},
	});
	return result;
}

function rewriteThisExpression(types, path) {
	path.replaceWith(types.memberExpression(types.thisExpression(), types.identifier("this")));
	path.skip();
}

function rewriteTailCalls(types, path) {
	path.traverse({
		ReturnStatement: {
			enter(path) {
				const argumentPath = path.get("argument");
				if (argumentPath.isConditionalExpression()) {
					path.replaceWith(types.ifStatement(argumentPath.node.test, types.returnStatement(argumentPath.node.consequent), types.returnStatement(argumentPath.node.alternate)));
				} else if (argumentPath.isLogicalExpression()) {
					const leftIdentifier = path.scope.generateUidIdentifier("left");
					path.insertBefore(types.variableDeclaration("var", [types.variableDeclarator(leftIdentifier, argumentPath.node.left)]));
					switch (argumentPath.node.operator) {
						case "||":
							path.replaceWith(types.ifStatement(leftIdentifier, types.returnStatement(leftIdentifier), types.returnStatement(argumentPath.node.right)));
							break;
						case "&&":
							path.replaceWith(types.ifStatement(leftIdentifier, types.returnStatement(argumentPath.node.right), types.returnStatement(leftIdentifier)));
							break;
						default:
							throw argumentPath.buildCodeFrameError("Unknown local operator: " + argumentPath.operator);
					}
				}
			},
			exit(path) {
				const argumentPath = path.get("argument");
				if (argumentPath.isCallExpression()) {
					if (argumentPath.node.callee.type == "MemberExpression") {
						// return foo.bar(...);
						path.replaceWith(types.blockStatement([
							types.expressionStatement(types.assignmentExpression("=", types.memberExpression(types.thisExpression(), types.identifier("next")), types.memberExpression(types.assignmentExpression("=", types.memberExpression(types.thisExpression(), types.identifier("this")), argumentPath.node.callee.object), argumentPath.node.callee.property, argumentPath.node.callee.computed))),
							types.expressionStatement(types.assignmentExpression("=", types.memberExpression(types.thisExpression(), types.identifier("args")), types.arrayExpression(argumentPath.node.arguments))),
							types.returnStatement(),
						]));
					} else {
						// return foo(...);
						path.replaceWith(types.blockStatement([
							types.expressionStatement(types.assignmentExpression("=", types.memberExpression(types.thisExpression(), types.identifier("this")), types.identifier("null"))),
							types.expressionStatement(types.assignmentExpression("=", types.memberExpression(types.thisExpression(), types.identifier("next")), argumentPath.node.callee)),
							types.expressionStatement(types.assignmentExpression("=", types.memberExpression(types.thisExpression(), types.identifier("args")), types.arrayExpression(argumentPath.node.arguments))),
							types.returnStatement(),
						]));
					}
				} else if (argumentPath.node) {
					// return ...;
					path.replaceWith(types.blockStatement([
						types.expressionStatement(types.assignmentExpression("=", types.memberExpression(types.thisExpression(), types.identifier("next")), types.identifier("undefined"))),
						types.expressionStatement(types.assignmentExpression("=", types.memberExpression(types.thisExpression(), types.identifier("result")), argumentPath.node)),
						types.returnStatement(),
					]));
				} else {
					// return;
					path.replaceWith(types.returnStatement(types.assignmentExpression("=", types.memberExpression(types.thisExpression(), types.identifier("next")), types.identifier("undefined"))));
				}
				path.skip();
			}
		},
		ThisExpression: {
			exit(path) {
				rewriteThisExpression(types, path);
			}
		},
		FunctionDeclaration(path) {
			path.skip();
		},
		FunctionExpression(path) {
			path.skip();
		},
		ClassMethod(path) {
			path.skip();
		},
		ObjectMethod(path) {
			path.skip();
		},
		ArrowFunctionExpression(path) {
			path.skip();
			path.traverse({
				ThisExpression: {
					exit(path) {
						rewriteThisExpression(types, path);
					}
				},
				FunctionDeclaration(path) {
					path.skip();
				},
				FunctionExpression(path) {
					path.skip();
				},
				ClassMethod(path) {
					path.skip();
				},
				ObjectMethod(path) {
					path.skip();
				},
			});
		},
	});
}

module.exports = function({ types, template }) {
	return {
		visitor: {
			FunctionDeclaration: {
				exit(path) {
					if (findTailCall(path)) {
						if (path.node.async || path.node.generator) {
							return;
						}
						this.hasTailCall = true;
						rewriteTailCalls(types, path);
						const tailFunction = types.functionExpression(path.scope.generateUidIdentifier(path.node.id.name), path.node.params, path.node.body);
						var parent = path.getFunctionParent() || path.getProgramParent();
						var body = parent.get("body.0");
						body.insertBefore(types.variableDeclaration("var", [
							types.variableDeclarator(path.node.id, types.callExpression(types.identifier("__as_tail_recursive"), [tailFunction]))
						]));
						path.remove();
						path.skip();
					}
				}
			},
			FunctionExpression: {
				exit(path) {
					if (findTailCall(path)) {
						if (path.node.async || path.node.generator) {
							return;
						}
						this.hasTailCall = true;
						rewriteTailCalls(types, path);
						path.replaceWith(types.callExpression(types.identifier("__as_tail_recursive"), [path.node]));
						path.skip();
					}
				}
			},
			ArrowFunctionExpression: {
				enter(path) {
					if (findTailCall(path)) {
						if (path.node.async || path.node.generator) {
							return;
						}
						let thatIdentifier;
						path.traverse({
							ThisExpression(path) {
								path.replaceWith(thatIdentifier || (thatIdentifier = path.scope.generateUidIdentifier("that")));
								requiresThat = true;
							},
							FunctionDeclaration(path) {
								path.skip();
							},
							FunctionExpression(path) {
								path.skip();
							},
							ClassMethod(path) {
								path.skip();
							},
							ObjectMethod(path) {
								path.skip();
							},
						})
						let functionExpression;
						if (path.node.body.type == "BlockStatement") {
							functionExpression = types.functionExpression(null, path.node.params, path.node.body.body);
						} else {
							functionExpression = types.functionExpression(null, path.node.params, types.blockStatement([types.returnStatement(path.node.body)]));
						}
						if (thatIdentifier) {
							path.replaceWith(types.callExpression(types.arrowFunctionExpression([thatIdentifier], functionExpression), [types.thisExpression()]))
						} else {
							path.replaceWith(functionExpression);
						}
					}
				}
			},
			Program: {
				exit(path) {
					if (this.hasTailCall) {
						path.get("body.0").insertBefore(template(`function __as_tail_recursive(recursiveFunction) {
							__recursion_trampoline.__recursive_body = recursiveFunction;
							return __recursion_trampoline;
							function __recursion_trampoline() {
								var state = { next: __recursion_trampoline, this: this, args: Array.prototype.slice.call(arguments), result: undefined };
								do {
									state.next.__recursive_body.apply(state, state.args);
								} while(state.next && state.next.__recursive_body);
								return state.next ? state.next.apply(state.this, state.args) : state.result;
							}
						}`)());
						path.stop();
					}
				}
			}
		}
	}
}
