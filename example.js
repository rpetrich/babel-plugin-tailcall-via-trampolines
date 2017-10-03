const fib = function(n, previous = 1, beforePrevious = 0) {
	if (n === 0) {
		return beforePrevious;
	}
	return fib(n - 1, previous + beforePrevious, previous);
}
