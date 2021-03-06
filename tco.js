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

function allPathsMatch(path, matchingNodeTypes) {
	if (!path || !path.node) {
		return true;
	}
	if (matchingNodeTypes.indexOf(path.node.type) !== -1) {
		return true;
	}
	const match = { all: false }
	const visitor = {
		IfStatement(path) {
			path.skip();
			if (allPathsMatch(path.get("test"), matchingNodeTypes) || (allPathsMatch(path.get("consequent"), matchingNodeTypes) && allPathsMatch(path.get("alternate"), matchingNodeTypes))) {
				this.match.all = true;
				path.stop();
			}
		},
		ConditionalExpression(path) {
			path.skip();
			if (allPathsMatch(path.get("test"), matchingNodeTypes) || (allPathsMatch(path.get("consequent"), matchingNodeTypes) && allPathsMatch(path.get("alternate"), matchingNodeTypes))) {
				this.match.all = true;
				path.stop();
			}
		},
		SwitchStatement(path) {
			path.skip();
			// TODO: Support checking that all cases match or fallthrough
			if (allPathsMatch(path.get("discriminant"), matchingNodeTypes)) {
				this.match.all = true;
				path.stop();
			}
		},
		DoWhileStatement(path) {
			path.skip();
			// TODO: Support detecting break/return statements
			if (allPathsMatch(path.get("body"), matchingNodeTypes)) {
				this.match.all = true;
				path.stop();
			}
		},
		WhileStatement(path) {
			path.skip();
			// TODO: Support detecting break/return statements
			if (allPathsMatch(path.get("test"), matchingNodeTypes)) {
				this.match.all = true;
				path.stop();
			}
		},
		ForInStatement(path) {
			path.skip();
			if (allPathsMatch(path.get("right"), matchingNodeTypes)) {
				this.match.all = true;
				path.stop();
			}
		},
		ForOfStatement(path) {
			path.skip();
			if (allPathsMatch(path.get("right"), matchingNodeTypes)) {
				this.match.all = true;
				path.stop();
			}
		},
		ForStatement(path) {
			path.skip();
			if (allPathsMatch(path.get("init"), matchingNodeTypes) || allPathsMatch(path.get("test"), matchingNodeTypes)) {
				this.match.all = true;
				path.stop();
			}
		},
		LogicalExpression(path) {
			path.skip();
			if (allPathsMatch(path.get("left"), matchingNodeTypes)) {
				this.match.all = true;
				path.stop();
			}
		},
		ReturnStatement(path) {
			path.stop();
		},
		BreakStatement(path) {
			path.stop();
		},
		ContinueStatement(path) {
			path.stop();
		},
		ThrowStatement(path) {
			// TODO: Handle throw statements correctly
			path.stop();
		},
		TryStatement(path) {
			path.skip();
			const catchClause = path.get("handler");
			if (catchClause.node) {
				if (allPathsMatch(catchClause, matchingNodeTypes)) {
					this.match.all = true;
					path.stop();
				}
			} else {
				path.stop();
			}
		},
		Function(path) {
			path.skip();
		}
	};
	for (let nodeType of matchingNodeTypes) {
		visitor[nodeType] = function(path) {
			this.match.all = true;
			path.stop();
		};
	}
	path.traverse(visitor, {match});
	return match.all;
}

function isPure(path) {
	if (path.isBooleanLiteral()) {
		return true;
	}
	if (path.isStringLiteral()) {
		return true;
	}
	if (path.isNullLiteral()) {
		return true;
	}
	if (path.isIdentifier()) {
		return true;
	}
	if (path.isThisExpression()) {
		return true;
	}
	if (path.isArrayExpression()) {
		return path.node.elements.all((argument, i) => isPure(path.get(`arguments.${i}`)));
	}
	if (path.isUnaryExpression()) {
		switch (path.node.operator) {
			case "void":
			case "!":
			case "+":
			case "-":
			case "~":
			case "typeof":
				return isPure(path.get("argument"))
				break;
		}
	}
	return false;
}

function isPureAndUndefined(path) {
	if (path.isIdentifier() && path.node.name === "undefined") {
		return true;
	}
	if (path.isUnaryExpression() && path.node.operator === "void" && isPure(path.get("argument"))) {
		return true;
	}
	return false;
}

function rewriteReturnedExpression(types, path, selfIdentifierName, selfUsesThis) {
	path.skip();
	if (path.isLogicalExpression()) {
		const leftIdentifier = path.scope.generateUidIdentifier("left");
		path.insertBefore(types.variableDeclaration("var", [types.variableDeclarator(leftIdentifier)]));
		path.replaceWith(types.conditionalExpression(types.assignmentExpression("=", leftIdentifier, path.node.left), leftIdentifier, path.node.right));
	}
	if (path.isConditionalExpression()) {
		return rewriteReturnedExpression(types, path.get("consequent"), selfIdentifierName, selfUsesThis) | rewriteReturnedExpression(types, path.get("alternate"), selfIdentifierName, selfUsesThis);
	}
	let usedTailReturn;
	const expressions = [];
	if (path.isCallExpression()) {
		if (path.node.callee.type == "MemberExpression") {
			// return foo.bar(...);
			// Uses a compound expression to avoid invoking the left side of the member expression twice (which would run side-effects twice!)
			// Evaluates left side of member expression, then right side, then arguments
			expressions.push(types.assignmentExpression("=", types.memberExpression(types.thisExpression(), types.identifier("next")), types.memberExpression(types.assignmentExpression("=", types.memberExpression(types.thisExpression(), types.identifier("this")), argumentPath.node.callee.object), argumentPath.node.callee.property, argumentPath.node.callee.computed)));
		} else {
			// return foo(...);
			// Evaluates left side of call expression, then arguments
			const callee = path.node.callee;
			const isSelf = callee.type === "Identifier" && callee.name === selfIdentifierName;
			if (!isSelf || selfUsesThis) {
				// Relies on the fact that self doesn't use this
				expressions.push(types.assignmentExpression("=", types.memberExpression(types.thisExpression(), types.identifier("this")), types.identifier("null")));
			}
			if (!isSelf) {
				// Relies on the fact that self was just called, and no need to set state.next again
				expressions.push(types.assignmentExpression("=", types.memberExpression(types.thisExpression(), types.identifier("next")), callee));
			}
		}
		if (path.node.arguments.length !== 0) {
			expressions.push(types.arrayExpression(path.node.arguments));
		} else if (expressions.length) {
			expressions.push(types.unaryExpression("void", expressions.pop()));
		} else {
			expressions.push(types.identifier("undefined"));
		}
	} else if (path.node && !isPureAndUndefined(path)) {
		// return ...;
		usedTailReturn = true;
		expressions.push(types.assignmentExpression("=", types.memberExpression(types.thisExpression(), types.identifier("next")), types.identifier("__tail_return")));
		expressions.push(types.arrayExpression([path.node]));
	} else {
		// return;
		usedTailReturn = true;
		expressions.push(types.unaryExpression("void", types.assignmentExpression("=", types.memberExpression(types.thisExpression(), types.identifier("next")), types.identifier("__tail_return"))));
	}
	// Prefer simpler forms
	path.replaceWith(expressions.length === 1 ? expressions[0] : types.sequenceExpression(expressions));
	return usedTailReturn;
}

function rewriteTailCalls(types, path, selfIdentifierName) {
	let selfUsesThis = false;
	if (selfIdentifierName) {
		path.traverse({
			ThisExpression(path) {
				selfUsesThis = true;
				path.stop();
			},
			Function(path) {
				path.skip();
			}
		});
	}
	let usedTailReturn = false;
	path.traverse({
		ReturnStatement: {
			exit(path) {
				usedTailReturn |= rewriteReturnedExpression(types, path.get("argument"), selfIdentifierName, selfUsesThis);
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
	// Handle the implicit "return undefined;" if not all paths through the function have an explicit return
	if (!allPathsMatch(path, ["ReturnStatement", "ThrowStatement"])) {
		path.node.body.body.push(types.expressionStatement(types.assignmentExpression("=", types.memberExpression(types.thisExpression(), types.identifier("next")), types.identifier("__tail_return"))));
	}
	return usedTailReturn;
}

function declaratorIsEffectivelyFinal(path) {
	if (!path.isVariableDeclarator() || !path.parentPath.isVariableDeclaration()) {
		return false;
	}
	if (path.parent.kind === "const") {
		return true;
	}
	const name = path.node.id.name;
	return path.scope.getBinding(name).constant;
}

function labelsForPath(path) {
	const labels = [];
	while (path && path.node) {
		if (path.isLabeledStatement()) {
			labels.push(path.node.label.name);
		}
		path = path.parentPath;
	}
	return labels;
}

function shouldTailCallOptimize(path) {
	const parentPath = path.parentPath;
	if (parentPath.isCallExpression()) {
		const callee = parentPath.get("callee");
		if (callee.isIdentifier() && /^__as_tail_recursive\d+$/.test(callee.node.name)) {
			return false;
		}
	}
	const labels = labelsForPath(path);
	const disabledIndex = labels.indexOf("not_tail_optimized");
	if (disabledIndex === -1) {
		return true;
	}
	const enabledIndex = labels.indexOf("tail_optimized");
	if (enabledIndex === -1) {
		return false;
	}
	return enabledIndex < disabledIndex;
}

module.exports = function({ types, template }) {
	return {
		visitor: {
			FunctionDeclaration: {
				exit(path) {
					if (findTailCall(path) && shouldTailCallOptimize(path)) {
						if (path.node.async || path.node.generator) {
							return;
						}
						const argumentCount = path.node.params.length;
						(this.tailCalls || (this.tailCalls = {}))[argumentCount] = true;
						if (rewriteTailCalls(types, path, path.node.id.name)) {
							this.usedTailReturn = true;
						}
						const tailFunction = types.functionExpression(path.scope.generateUidIdentifier(path.node.id.name), path.node.params, path.node.body);
						var parent = path.getFunctionParent() || path.getProgramParent();
						var body = parent.get("body.0");
						body.insertBefore(types.variableDeclaration("var", [
							types.variableDeclarator(path.node.id, types.callExpression(types.identifier("__as_tail_recursive" + argumentCount), [tailFunction]))
						]));
						path.remove();
						path.skip();
					}
				}
			},
			FunctionExpression: {
				exit(path) {
					if (findTailCall(path) && shouldTailCallOptimize(path)) {
						if (path.node.async || path.node.generator) {
							return;
						}
						const argumentCount = path.node.params.length;
						(this.tailCalls || (this.tailCalls = {}))[argumentCount] = true;
						if (rewriteTailCalls(types, path, declaratorIsEffectivelyFinal(path.parentPath) ? path.parent.id.name : null)) {
							this.usedTailReturn = true;
						}
						path.replaceWith(types.callExpression(types.identifier("__as_tail_recursive" + argumentCount), [path.node]));
						path.skip();
					}
				}
			},
			ArrowFunctionExpression: {
				enter(path) {
					if (findTailCall(path) && shouldTailCallOptimize(path)) {
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
							functionExpression = types.functionExpression(null, path.node.params, path.node.body);
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
					if (this.tailCalls) {
						const body = path.get("body.0");
						body.insertBefore(template(`function __recursive_toString() { return this.__recursive_body.toString(); }`)());
						for (var i in this.tailCalls) {
							if (this.tailCalls.hasOwnProperty(i)) {
								let arguments = Array(i-0).toString().split(",").map((v,i) => "_" + i).join(",");
								body.insertBefore(template(`function __as_tail_recursive${i}(recursiveFunction) {
									__recursion_trampoline.__recursive_body = recursiveFunction;
									__recursion_trampoline.toString = __recursive_toString;
									return __recursion_trampoline;
									function __recursion_trampoline(${arguments}) {
										var state = { next: __recursion_trampoline, this: this };
										var args = Array.prototype.slice.call(arguments);
										do {
											args = state.next.__recursive_body.apply(state, args);
										} while(state.next.__recursive_body);
										return state.next.apply(state.this, args);
									}
								}`)());
							}
						}
						if (this.usedTailReturn) {
							body.insertBefore(template(`function __tail_return(result) {
								return result;
							}`)());
						}
						path.stop();
					}
				}
			}
		}
	}
}
