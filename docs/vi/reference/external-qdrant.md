# External Qdrant

Semantic search lưu vector trong [Qdrant](https://qdrant.tech). Knowns có thể tự
chạy Qdrant cho bạn, hoặc kết nối tới một Qdrant bạn đã có sẵn.

| Mode | Knowns làm gì | Endpoint |
|---|---|---|
| `managed` (mặc định) | Tải binary Qdrant đã pin sẵn, start/stop process, quản lý data directory | `http://127.0.0.1:6333`, cố định |
| `external` | Chỉ kết nối qua HTTP. Không install, không start, không stop, không cleanup process | Tùy bạn cấu hình |

Managed là mặc định và không cần setup gì. Trang này nói về external mode.

## Khi nào cần external mode

- Managed binary không chạy được trên platform của bạn. Knowns pin Qdrant 1.14.1
  cho `darwin/arm64`, `darwin/amd64`, `linux/amd64`, `linux/arm64`. Bản
  `linux/amd64` link với glibc, nên sẽ không chạy trên distro dùng musl như
  Alpine.
- Bạn đã chạy sẵn Qdrant, bằng Docker hoặc như một service dùng chung, và muốn
  một instance thay vì mỗi máy một cái.
- Bạn chạy Knowns trong container và không muốn thêm một process chạy dài bên
  trong đó.
- Bạn muốn Qdrant nằm trên host của mình, với backup và TLS riêng.

Nếu managed mode đang chạy tốt thì cứ giữ nguyên. External mode cho bạn quyền
kiểm soát endpoint, đổi lại bạn nhận luôn phần việc vận hành đi kèm.

## Setup

### Cách A: environment variable

Nhanh nhất. Chỉ cần set URL là đủ, vì bản thân nó đã implies external mode.

```bash
export KNOWNS_QDRANT_URL=https://qdrant.example.com:6333
export KNOWNS_QDRANT_API_KEY=<key của bạn>
```

Không có gì được ghi vào project. Đây là dạng phù hợp cho CI, container, và để
thử external mode trước khi quyết định.

### Cách B: project config

Ghi vào `.knowns/config.json` khi cả team cần dùng chung một endpoint.

**Set URL trước, set mode sau.** Config được validate ở mỗi lần ghi, và
`mode: external` mà thiếu URL sẽ bị từ chối.

```bash
knowns config set settings.semanticSearch.vectorStore.externalURL "https://qdrant.example.com:6333"
knowns config set settings.semanticSearch.vectorStore.mode external
```

Kết quả:

```json
{
  "settings": {
    "semanticSearch": {
      "enabled": true,
      "model": "qwen3-embedding:0.6b",
      "provider": "ollama",
      "vectorStore": {
        "backend": "qdrant",
        "mode": "external",
        "externalURL": "https://qdrant.example.com:6333"
      }
    }
  }
}
```

API key không bao giờ nằm trong file này. Nó chỉ đến từ environment.

### Tự chạy Qdrant

Image chính thức có sẵn cho cả amd64 và arm64:

```bash
docker run -d --name knowns-qdrant \
  -p 127.0.0.1:6333:6333 \
  -v qdrant_storage:/qdrant/storage \
  qdrant/qdrant:v1.14.1
```

Rồi trỏ Knowns vào đó:

```bash
export KNOWNS_QDRANT_URL=http://127.0.0.1:6333
```

Bind vào `127.0.0.1` thay vì `0.0.0.0` là có chủ đích: nó giữ endpoint ở
loopback, trường hợp duy nhất mà HTTP thường được chấp nhận.

### Build index

Collection nằm trên server, nên một endpoint mới thì chưa có gì trong đó, và
pointer cũ đang trỏ tới một collection không tồn tại.

```bash
knowns search index --wait
```

## Ràng buộc

| Quy tắc | Chi tiết |
|---|---|
| Ngoài loopback bắt buộc HTTPS | `http://` chỉ được chấp nhận cho `localhost`, `127.0.0.1`, `::1`. Mọi host khác phải dùng `https://`, verify certificate như bình thường. |
| Không nhét secret vào URL | URL không được chứa user info, query string, hay fragment. |
| API key lấy từ environment | Chỉ qua `KNOWNS_QDRANT_API_KEY`. Nó được gửi bằng header `api-key` của Qdrant và không bao giờ được ghi vào project config, pointer file, status output, doctor evidence, hay log. |

Quy tắc HTTPS là chỗ hay vấp nhất. Nếu Knowns chạy trong một container còn
Qdrant trong container khác, `http://qdrant:6333` qua Docker network **sẽ bị từ
chối**, vì `qdrant` không phải host loopback. Hoặc đặt cả hai chung một network
namespace rồi dùng `127.0.0.1`, hoặc dựng TLS phía trước Qdrant.

## Kiểm tra

```bash
knowns qdrant status --plain
```

External mode sẽ báo:

```text
state       external
backend     qdrant
mode        external
managed     false
externalURL https://qdrant.example.com:6333
message     external Qdrant URL configured; managed process ownership disabled
```

Sau đó kiểm tra readiness của search:

```bash
knowns doctor --scope search
```

## External mode khác gì

- `knowns qdrant install`, `start`, `stop` không còn áp dụng. `install` trả về
  lỗi; `start` và `stop` báo là đã bypass. Việc start/stop server là của bạn.
- `knowns doctor` không probe endpoint. Nó báo collection check dưới dạng warning
  nói rõ điều đó, thay vì giả vờ đã verify một server mà nó chưa hề kết nối tới.
  Bạn tự kiểm tra endpoint và collection.
- Cleanup rất bảo thủ. Generation cũ chỉ bị xóa khi pointer và generation history
  của chính store này chứng minh được quyền sở hữu. Mọi thứ khác chỉ được báo là
  candidate và giữ nguyên, nên Knowns không bao giờ xóa một collection trên
  server dùng chung mà nó không chứng minh được là do mình tạo.
- Việc upgrade là của bạn. Không có gì pin version server giúp bạn.

## Xử lý lỗi

| Thông báo | Nguyên nhân | Cách xử lý |
|---|---|---|
| `non-loopback Qdrant endpoints require HTTPS` | Dùng `http://` với host không phải loopback | Chuyển sang `https://`, hoặc truy cập server qua `127.0.0.1` |
| `qdrant url must not contain credentials, query secrets, or fragments` | Nhét key hoặc token vào URL | Bỏ ra và dùng `KNOWNS_QDRANT_API_KEY` |
| `mode "external" requires externalURL` | Set `mode` trước khi set URL | Set `externalURL` trước, rồi mới set `mode` |
| `qdrant install applies only to managed mode` | Chạy `knowns qdrant install` ở external mode | Đúng như thiết kế. Không có gì để install |
| `qdrant pointer missing; run: knowns search index --wait` | Endpoint mới chưa có collection | Chạy `knowns search index --wait` |
| `unsupported Qdrant platform <os>/<arch>` | Không có managed binary cho platform này | Trang này chính là câu trả lời. Cấu hình external endpoint |

## Quay lại managed mode

```bash
knowns config set settings.semanticSearch.vectorStore.mode managed
knowns qdrant install
knowns search index --wait
```

Nhớ unset `KNOWNS_QDRANT_URL` nếu đang set. Nó override project config và tự nó
ép về external mode.

## Environment variables

| Biến | Công dụng |
|---|---|
| `KNOWNS_QDRANT_URL` | External endpoint. Implies `mode: external` |
| `KNOWNS_SEMANTIC_QDRANT_URL` | Alias của biến trên |
| `KNOWNS_QDRANT_API_KEY` | API key, gửi bằng header `api-key` |
| `KNOWNS_SEMANTIC_VECTOR_MODE` | `managed` hoặc `external` |
| `KNOWNS_SEMANTIC_VECTOR_BACKEND` | `qdrant`, `sqlite`, hoặc `none` |
| `KNOWNS_SEMANTIC_VECTOR_ENABLED` | Bật/tắt semantic vector search |
| `KNOWNS_SEMANTIC_VECTOR_MANAGED_ROOT` | Managed runtime root, mặc định `~/.knowns/runtime/qdrant` |
| `KNOWNS_QDRANT_MIRROR` | Host tải thay thế cho managed binary. Vẫn verify checksum như thường |

Thứ tự ưu tiên: environment > project config > global settings > mặc định.

## Xem thêm

- [Semantic search](./semantic-search.md)
- [Cấu hình](./configuration.md)
- [Ollama Embedding Models](./ollama-embedding-models.md)
