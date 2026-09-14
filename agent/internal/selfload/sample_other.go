//go:build !windows

package selfload

import "time"

// Windows 以外では計らない。配るのは Windows だけなので、
// ここは「テストと組み立てが通る」ためだけに置いてある
type Sampler struct{}

func NewSampler() *Sampler { return &Sampler{} }

func (s *Sampler) Sample(idle bool) (Sample, bool) {
	return Sample{At: time.Now(), Idle: idle}, false
}
