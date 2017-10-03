function __as_tail_recursive(recursiveFunction) {
	__recursion_trampoline.__recursive_body = recursiveFunction;
	return __recursion_trampoline;

	function __recursion_trampoline() {
		var state = {
			next: __recursion_trampoline,
			this: this,
			args: Array.prototype.slice.call(arguments),
			result: undefined
		};

		do {
			state.next.__recursive_body.apply(state, state.args);
		} while (state.next && state.next.__recursive_body);

		return state.next ? state.next.apply(state.this, state.args) : state.result;
	}
}

const fib = __as_tail_recursive(function (n, previous = 1, beforePrevious = 0) {
	if (n === 0) {
		return this.next = undefined, this.result = beforePrevious;
	}
	return this.args = [n - 1, previous + beforePrevious, previous];
});

