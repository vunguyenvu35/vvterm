package sshx

import (
	"sync"
	"time"
)

// Batcher coalesces many small writes into one flush per interval (~16 ms) or when
// maxBytes is reached, so heavy output (tail -f) does not flood the UI with events.
// flush is invoked while holding the lock so chunks are always delivered in order;
// it must therefore be quick and must not call back into the Batcher.
type Batcher struct {
	mu       sync.Mutex
	buf      []byte
	timer    *time.Timer
	interval time.Duration
	maxBytes int
	flush    func([]byte)
	closed   bool
}

func NewBatcher(interval time.Duration, maxBytes int, flush func([]byte)) *Batcher {
	return &Batcher{interval: interval, maxBytes: maxBytes, flush: flush}
}

func (b *Batcher) Write(p []byte) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return
	}
	b.buf = append(b.buf, p...)
	if len(b.buf) >= b.maxBytes {
		b.drain()
		return
	}
	if b.timer == nil {
		b.timer = time.AfterFunc(b.interval, func() {
			b.mu.Lock()
			defer b.mu.Unlock()
			b.timer = nil
			b.drain()
		})
	}
}

// drain must be called with b.mu held.
func (b *Batcher) drain() {
	if b.timer != nil {
		b.timer.Stop()
		b.timer = nil
	}
	if len(b.buf) == 0 {
		return
	}
	out := b.buf
	b.buf = nil
	b.flush(out)
}

// Close flushes whatever is pending and stops further writes.
func (b *Batcher) Close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.closed = true
	b.drain()
}
