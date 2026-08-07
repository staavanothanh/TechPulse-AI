# ADR-0005: Use hybrid search with application-level cosine similarity

**Date**: 2026-08-08  
**Status**: accepted  
**Deciders**: Project owner  
**Record type**: Backfill of an approved MVP decision

## Context

MVP cần keyword search đáng tin cậy và semantic retrieval để AI Q&A nổi bật, nhưng dataset chỉ khoảng 250–400 article. MongoDB Atlas Search/Vector Search không nằm trong dependency bắt buộc. Embedding provider có thể lỗi nên feed/search không được phụ thuộc hoàn toàn vào vector.

## Decision

Keyword baseline dùng MongoDB text index với `default_language: none` và normalized Vietnamese text. Semantic path dùng OpenRouter `baai/bge-m3`, lưu vector 1024 chiều/version trong MongoDB và tính cosine trên candidate set đã lọc trong Node.js; text search là fallback.

## Alternatives Considered

### Alternative 1: Chỉ keyword search

- **Pros**: Đơn giản, rẻ và ít dependency.
- **Cons**: Không chứng minh semantic retrieval/RAG tốt với câu hỏi diễn đạt khác từ khóa.
- **Why not**: AI retrieval là phần tạo khác biệt chính của đồ án.

### Alternative 2: MongoDB Atlas Vector Search ngay từ MVP

- **Pros**: Query vector ở database và scale tốt hơn.
- **Cons**: Thêm hạ tầng/index dependency chưa cần cho corpus nhỏ.
- **Why not**: Application cosine đủ để chứng minh capability và dễ fallback.

### Alternative 3: Dedicated vector/search service

- **Pros**: Retrieval feature và scale chuyên dụng.
- **Cons**: Thêm service, credential, cost và vận hành.
- **Why not**: Vượt phạm vi bốn tuần và acceptance gate.

## Consequences

### Positive

- Search vẫn hoạt động khi embedding provider không khả dụng.
- Model/version/hash làm re-index và reproducibility rõ ràng.
- Không cần thêm database/service cho demo corpus.

### Negative

- Application đọc và tính score vectors; không phù hợp corpus lớn.
- Hybrid weight/candidate filter cần benchmark tiếng Việt.

### Risks

- Vector khác model/version bị trộn; repository từ chối mismatch và model change tạo full re-index.
- BGE-M3 có thể không đạt chất lượng kỳ vọng; benchmark top-5 trước khi khóa `embeddingVersion=1`, không runtime-fallback sang vector model khác.
