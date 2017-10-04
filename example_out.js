function __as_tail_recursive(recursiveFunction) {
	__recursion_trampoline.__recursive_body = recursiveFunction;
	return __recursion_trampoline;

	function __recursion_trampoline() {
		var state = {
			next: __recursion_trampoline,
			this: this
		};
		var args = Array.prototype.slice.call(arguments);

		do {
			args = state.next.__recursive_body.apply(state, args);
		} while (state.next.__recursive_body);

		return state.next.apply(state.this, args);
	}
}

function __tail_return(result) {
	return result;
}

const fib = __as_tail_recursive(function (n, previous = 1, beforePrevious = 0) {
	if (n === 0) {
		return this.next = __tail_return, [beforePrevious];
	}
	return [n - 1, previous + beforePrevious, previous];
});

