# ADR-0008: Use JavaScript and JSX for implementation

**Date**: 2026-08-08  
**Status**: accepted  
**Deciders**: Project owner  
**Record type**: Approved MVP decision

## Context

Học phần dạy React và Node.js bằng JavaScript/JSX, trong khi TypeScript không nằm trong nội dung đã học. Dự án chỉ có bốn tuần và được thiết kế solo-first, nên ngôn ngữ cần giúp nhóm giải thích code chắc chắn trước giảng viên mà không tạo thêm một learning curve bắt buộc. HTTP contract vẫn cần đồng bộ chặt giữa React và Express.

## Decision

MVP dùng JavaScript/JSX: `.jsx` cho React component và `.js` cho Node.js/Express, script, migration và test; không tạo `.ts`/`.tsx`. OpenAPI là HTTP authority, generator sinh JavaScript client/JSDoc schema, và runtime validation cùng automated tests bảo vệ boundary. JSDoc hoặc `// @ts-check` có thể dùng như editor aid nhưng không biến TypeScript compiler thành build requirement.

## Alternatives Considered

### Alternative 1: TypeScript/TSX toàn bộ

- **Pros**: Static checking tốt, tooling và refactor support mạnh.
- **Cons**: Thêm syntax/compiler/config không thuộc học phần và tăng phần phải học/giải trình trong bốn tuần.
- **Why not**: Lợi ích không bù được rủi ro tiến độ và lệch learning outcomes của đồ án.

### Alternative 2: Trộn JavaScript frontend và TypeScript backend

- **Pros**: Backend có static checking trong khi React vẫn bám bài học.
- **Cons**: Hai toolchain và conventions, làm contract generation/test phức tạp hơn.
- **Why not**: Tăng cognitive load mà không cải thiện giá trị demo tương xứng.

### Alternative 3: JavaScript/JSX với runtime contract

- **Pros**: Bám sát học phần, dễ trình bày và có một toolchain thống nhất.
- **Cons**: Không bắt mọi type mismatch ở compile time.
- **Why chosen**: OpenAPI, runtime schema validation, JSDoc và test tập trung đúng các boundary rủi ro cao.

## Consequences

### Positive

- Nhóm có thể dùng trực tiếp kiến thức React/Node.js đã học và dành thời gian cho ingestion, MongoDB, AI/citation.
- Frontend/backend dùng cùng module conventions và scripts.
- Giảng viên có thể đánh giá rõ phần mở rộng kỹ thuật mà không bị che bởi một ngôn ngữ ngoài syllabus.

### Negative

- Refactor và field mismatch có thể chỉ lộ ở lint/runtime/test.
- Team phải kỷ luật hơn với OpenAPI, validation, JSDoc và fixtures.

### Risks

- Frontend/backend tự viết DTO riêng gây drift; cấm copy schema, sinh client/JSDoc từ OpenAPI và chạy contract tests.
- JavaScript code thiếu cấu trúc; dùng module boundaries, lint, small functions và explicit validation thay vì thêm abstraction tùy ý.

