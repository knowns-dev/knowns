package handlers

import "testing"

func TestHistoryPageArgsRequireNonNegativeIntegers(t *testing.T) {
	tests := []struct {
		name    string
		args    map[string]any
		offset  int
		limit   int
		wantErr bool
	}{
		{name: "missing", args: map[string]any{}},
		{name: "valid JSON numbers", args: map[string]any{"offset": float64(2), "limit": float64(25)}, offset: 2, limit: 25},
		{name: "fractional offset", args: map[string]any{"offset": 1.5}, wantErr: true},
		{name: "negative limit", args: map[string]any{"limit": float64(-1)}, wantErr: true},
		{name: "wrong type", args: map[string]any{"offset": "2"}, wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			offset, limit, err := historyPageArgs(test.args)
			if test.wantErr {
				if err == nil {
					t.Fatalf("historyPageArgs(%v) accepted invalid input", test.args)
				}
				return
			}
			if err != nil || offset != test.offset || limit != test.limit {
				t.Fatalf("historyPageArgs(%v) = (%d, %d, %v)", test.args, offset, limit, err)
			}
		})
	}
}
