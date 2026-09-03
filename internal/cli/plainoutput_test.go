package cli

import (
	"strings"
	"testing"
)

// hasANSI reports whether s carries any escape sequence.
func hasANSI(s string) bool { return strings.Contains(s, "\x1b[") }

// TestPlainOutputStripsStyling covers the defect where --plain was accepted on
// every command but honored on none: lipgloss v2 renders full ANSI and only
// downsamples at the output layer, which fmt.Print* bypasses.
func TestPlainOutputStripsStyling(t *testing.T) {
	t.Cleanup(func() { SetPlainOutput(false) })

	SetPlainOutput(false)
	styled := RenderSuccess("Created task abc123: Probe")
	if !hasANSI(styled) {
		t.Fatalf("default output should be styled, got %q", styled)
	}

	SetPlainOutput(true)
	for name, got := range map[string]string{
		"RenderSuccess":     RenderSuccess("Created task abc123: Probe"),
		"RenderError":       RenderError("boom"),
		"RenderWarning":     RenderWarning("careful"),
		"RenderInfo":        RenderInfo("fyi"),
		"RenderStatusBadge": RenderStatusBadge("in-progress"),
		"RenderPriority":    RenderPriorityBadge("high"),
		"RenderKeyValue":    RenderKeyValue("id", "abc123"),
	} {
		if hasANSI(got) {
			t.Errorf("%s: plain mode must not emit ANSI, got %q", name, got)
		}
	}

	if !strings.Contains(RenderSuccess("Created task abc123: Probe"), "Created task abc123: Probe") {
		t.Error("plain mode dropped the message text")
	}
}

// TestPlainOutputIsReversible guards the snapshot restore, so a plain-mode run
// inside a test cannot leak styling changes into the next one.
func TestPlainOutputIsReversible(t *testing.T) {
	t.Cleanup(func() { SetPlainOutput(false) })

	before := RenderSuccess("x")
	SetPlainOutput(true)
	if PlainOutput() != true {
		t.Fatal("PlainOutput() should report true after enabling")
	}
	SetPlainOutput(false)
	if got := RenderSuccess("x"); got != before {
		t.Errorf("styles not restored: before %q, after %q", before, got)
	}
	if PlainOutput() != false {
		t.Error("PlainOutput() should report false after disabling")
	}
}
