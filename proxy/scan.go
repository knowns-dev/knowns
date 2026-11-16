package main

// A minimal scanner for one JSON-RPC line. The proxy only needs the top-level id, method, params,
// result and error of a message, so it finds those members without decoding (or copying) the rest.

// topLevel returns the raw bytes of the wanted top-level members of a JSON object, as sub-slices
// of line. ok is false when line is not a JSON object.
func topLevel(line []byte, wanted ...string) (found map[string][]byte, ok bool) {
	found, ok, _ = scanObject(line, wanted...)
	return found, ok
}

// scanObject is topLevel that also reports a repeated top-level key of any name. Go keeps the
// first of two equal keys and the engine's JSON.parse keeps the last, so a message that repeats a
// key is read differently on the two sides and the proxy must not trust its own reading.
func scanObject(line []byte, wanted ...string) (found map[string][]byte, ok bool, dup bool) {
	seen := map[string]bool{}
	i := skipWS(line, 0)
	if i >= len(line) || line[i] != '{' {
		return nil, false, false
	}
	i++
	found = map[string][]byte{}
	for {
		i = skipWS(line, i)
		if i >= len(line) {
			return found, false, dup
		}
		if line[i] == '}' {
			return found, true, dup
		}
		if line[i] == ',' {
			i++
			continue
		}
		if line[i] != '"' {
			return found, false, dup
		}
		end := skipString(line, i)
		if end < 0 {
			return found, false, dup
		}
		key := string(line[i+1 : end-1])
		if seen[key] {
			dup = true
		}
		seen[key] = true
		i = skipWS(line, end)
		if i >= len(line) || line[i] != ':' {
			return found, false, dup
		}
		i = skipWS(line, i+1)
		vend := skipValue(line, i)
		if vend < 0 {
			return found, false, dup
		}
		for _, w := range wanted {
			if key == w {
				if _, dup := found[key]; !dup {
					found[key] = line[i:vend]
				}
				break
			}
		}
		i = vend
	}
}

func skipWS(b []byte, i int) int {
	for i < len(b) && (b[i] == ' ' || b[i] == '\t' || b[i] == '\r' || b[i] == '\n') {
		i++
	}
	return i
}

// skipString returns the index just past the closing quote of the string starting at b[i].
func skipString(b []byte, i int) int {
	for j := i + 1; j < len(b); j++ {
		switch b[j] {
		case '\\':
			j++
		case '"':
			return j + 1
		}
	}
	return -1
}

// skipValue returns the index just past the JSON value starting at b[i], or -1.
func skipValue(b []byte, i int) int {
	if i >= len(b) {
		return -1
	}
	switch b[i] {
	case '"':
		return skipString(b, i)
	case '{', '[':
		depth := 0
		for j := i; j < len(b); j++ {
			switch b[j] {
			case '"':
				e := skipString(b, j)
				if e < 0 {
					return -1
				}
				j = e - 1
			case '{', '[':
				depth++
			case '}', ']':
				depth--
				if depth == 0 {
					return j + 1
				}
			}
		}
		return -1
	default:
		j := i
		for j < len(b) && b[j] != ',' && b[j] != '}' && b[j] != ']' && b[j] != ' ' && b[j] != '\t' && b[j] != '\r' && b[j] != '\n' {
			j++
		}
		if j == i {
			return -1
		}
		return j
	}
}
