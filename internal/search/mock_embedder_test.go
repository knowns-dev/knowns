package search

import (
	"math"
	"testing"
)

// TestMockEmbedderSeparatesDifferentTexts is the property that makes the mock
// worth anything. The constant-vector stub used elsewhere in these tests gives
// every document the same direction, so every similarity ties and a ranking
// evaluation over it measures nothing at all.
func TestMockEmbedderSeparatesDifferentTexts(t *testing.T) {
	m := NewMockEmbedder()
	a, err := m.EmbedDocument("retrieval evaluation gate")
	if err != nil {
		t.Fatalf("EmbedDocument: %v", err)
	}
	b, err := m.EmbedDocument("skills scope global install")
	if err != nil {
		t.Fatalf("EmbedDocument: %v", err)
	}
	if cosine(a, b) > 0.9 {
		t.Fatalf("unrelated texts embed almost identically: cosine=%f", cosine(a, b))
	}
}

// Determinism is what lets a baseline recorded on one machine hold on another.
func TestMockEmbedderIsDeterministic(t *testing.T) {
	m := NewMockEmbedder()
	first, _ := m.EmbedDocument("same text")
	second, _ := m.EmbedDocument("same text")
	if cosine(first, second) < 0.999999 {
		t.Fatal("the same text embedded to two different vectors")
	}
	// A query and a document of identical text must also agree, or the query
	// leg and the index leg would never line up.
	q, _ := m.EmbedQuery("same text")
	if cosine(first, q) < 0.999999 {
		t.Fatal("query and document embeddings of the same text disagree")
	}
}

// Vectors must be unit length and spread across the sphere. Crowding one octant
// would push every cosine similarity near 1 and make the threshold meaningless.
func TestMockEmbedderVectorsAreNormalisedAndSigned(t *testing.T) {
	m := NewMockEmbedder()
	vec, _ := m.EmbedDocument("a document about nothing in particular")
	if len(vec) != m.Dimensions() {
		t.Fatalf("len = %d, want %d", len(vec), m.Dimensions())
	}
	var norm float64
	negatives := 0
	for _, v := range vec {
		norm += float64(v) * float64(v)
		if v < 0 {
			negatives++
		}
	}
	if math.Abs(math.Sqrt(norm)-1) > 1e-5 {
		t.Fatalf("vector norm = %f, want 1", math.Sqrt(norm))
	}
	if negatives == 0 {
		t.Fatal("no negative components; vectors are confined to one octant")
	}
}

func cosine(a, b []float32) float64 {
	var dot, na, nb float64
	for i := range a {
		dot += float64(a[i]) * float64(b[i])
		na += float64(a[i]) * float64(a[i])
		nb += float64(b[i]) * float64(b[i])
	}
	if na == 0 || nb == 0 {
		return 0
	}
	return dot / (math.Sqrt(na) * math.Sqrt(nb))
}
