# Ollama Embedding Models

Trang này là nguồn văn bản duy nhất cho hướng dẫn embedding của semantic search. Setup, `doctor`, và `init` đều trỏ về đây thay vì lặp lại nội dung, nên lời khuyên không bị lệch giữa các nơi — nếu bạn thấy một message khác cách diễn đạt trong terminal, message đó sẽ dẫn link về trang này thay vì viết lại nó.

Semantic search cần một embedding model để chuyển text thành vector. Knowns chạy model đó qua [Ollama](https://ollama.com), một runtime local, hoặc qua bất kỳ OpenAI-compatible embeddings API nào. Keyword (BM25) search không phụ thuộc vào cái nào cả — nó hoạt động ngay khi project được init, có hay không có Ollama.

## Model được khuyến nghị

Ba model Apache-2.0, Ollama-native được seed sẵn vào global model registry của mọi máy (`~/.knowns/settings.json`) ngay lần đầu Knowns đọc file này, nên lần index đầu tiên luôn có model để resolve, kể cả trên máy hoàn toàn mới.

| Model | Dimensions | Context | Tradeoff | Lệnh pull |
| --- | --- | --- | --- | --- |
| `qwen3-embedding:0.6b` (default) | 1024 | 32.768 token | Chất lượng retrieval tốt nhất trong ba model; instruction-aware để rank tốt hơn; lớn và chậm nhất khi embed | `ollama pull qwen3-embedding:0.6b` |
| `nomic-embed-text` | 768 | 8.192 token | Cân bằng — nhỏ và nhanh hơn model mặc định, nhưng context rộng hơn `all-minilm` nhiều | `ollama pull nomic-embed-text` |
| `all-minilm` | 384 | 256 token | Nhỏ và nhanh nhất; phù hợp corpus lớn khi tốc độ index và RAM quan trọng hơn cả, đổi lại chunk dài bị cắt bớt và chất lượng retrieval thấp hơn | `ollama pull all-minilm` |

`qwen3-embedding:0.6b` là model mặc định khi cấu hình `provider: ollama` mà không chỉ định model cụ thể. Chọn `nomic-embed-text` hoặc `all-minilm` bằng `knowns config set semanticSearch.model <name>` nếu tradeoff của chúng phù hợp hơn với project của bạn.

## Cài Ollama

1. Cài Ollama từ [ollama.com/download](https://ollama.com/download) (hỗ trợ macOS, Linux, Windows).
2. Khởi động — trên macOS và Windows, app đã cài sẽ tự chạy nó; trên Linux, hoặc khi cần chạy tay, dùng `ollama serve`.
3. Pull model bạn muốn bằng lệnh trong bảng trên, ví dụ:

   ```bash
   ollama pull qwen3-embedding:0.6b
   ```

4. Trỏ project vào model đó:

   ```bash
   knowns config set semanticSearch.enabled true
   knowns config set semanticSearch.provider ollama
   knowns config set semanticSearch.model qwen3-embedding:0.6b
   knowns search --reindex
   ```

`knowns init` và `knowns settings` có thể làm bước 3–4 một cách interactive và sẽ ưu tiên đề xuất model đã có sẵn trên máy trước model mặc định, nhưng không lệnh nào tự động pull model giúp bạn — một lần pull có thể tốn hàng trăm MB, nên luôn cần `ollama pull` tường minh.

## Dùng provider OpenAI-compatible của bên thứ ba

Mặc định không seed sẵn provider `api` nào: endpoint local của Ollama không cần credential, trong khi endpoint bên thứ ba luôn cần URL và thường cần key, nên một entry giữ chỗ sẽ resolve được rồi mới fail khi gọi request — còn tệ hơn cả việc không tồn tại. Tự đăng ký một provider khi bạn muốn dùng hosted embeddings API thay vì model Ollama local:

```bash
knowns provider add \
  --id openai \
  --name "OpenAI" \
  --api-base https://api.openai.com/v1 \
  --api-key sk-...

knowns config set semanticSearch.provider openai
knowns config set semanticSearch.model text-embedding-3-small
```

Bản thân model entry được thêm thủ công vào `~/.knowns/settings.json`, theo
shape bên dưới. Knowns giữ nguyên các field nó không nhận ra khi ghi file đó,
nên entry bạn tự thêm vẫn tồn tại sau khi seeding hoặc upgrade.

Lệnh này ghi một entry có dạng như sau vào `~/.knowns/settings.json`:

```json
{
  "providers": {
    "openai": {
      "name": "OpenAI",
      "apiBase": "https://api.openai.com/v1",
      "apiKey": "sk-...",
      "timeout": 30,
      "batchSize": 64,
      "retry": { "maxRetries": 3, "initialDelay": 1000, "maxDelay": 30000 }
    }
  },
  "models": {
    "text-embedding-3-small": {
      "provider": "openai",
      "model": "text-embedding-3-small",
      "dimensions": 1536,
      "maxTokens": 8191
    }
  }
}
```

Bất kỳ endpoint embeddings OpenAI-compatible nào cũng dùng theo cách này — chỉ `--api-base`, `--api-key`, tên model, và `dims`/`tokens` là thay đổi.

## Bốn trạng thái

Setup, `doctor`, và `init` đều nhận diện một trong bốn trạng thái sau và đưa ra bước tiếp theo khác nhau cho từng trạng thái. Ở mọi trạng thái trừ "ready," keyword search vẫn hoạt động — semantic search bị giảm cấp không bao giờ lấy mất khả năng search.

| Trạng thái | Ý nghĩa | Bước tiếp theo | Keyword search |
| --- | --- | --- | --- |
| Chưa cài Ollama | Không có binary hay service Ollama nào phản hồi | Cài từ [ollama.com/download](https://ollama.com/download), rồi pull model bạn muốn | Vẫn hoạt động |
| Đã cài nhưng chưa chạy | Ollama có mặt nhưng không phản hồi request | Khởi động (`ollama serve`, hoặc app Ollama của platform bạn), rồi pull model nếu chưa có | Vẫn hoạt động |
| Đang chạy, thiếu model | Ollama phản hồi, nhưng model đã cấu hình chưa được pull | Chạy `ollama pull <model>` cho model project bạn đã cấu hình | Vẫn hoạt động |
| Sẵn sàng | Ollama đang chạy và model đã cấu hình đã có sẵn | Không cần làm gì — semantic search đã sẵn sàng | Cũng hoạt động |

Nếu chỉ đọc một dòng của trang này: cài Ollama từ [ollama.com/download](https://ollama.com/download), rồi chạy `ollama pull qwen3-embedding:0.6b`.

## Trang liên quan

- [Semantic search](./semantic-search.md)
- [Cấu hình](./configuration.md)
