# Nhật Ký Chỉnh Sửa Tính Năng Dự Án (Project Modifications)

Tài liệu này ghi lại các cập nhật, cải tiến tính năng và giao diện người dùng (UI/UX) đã được triển khai trong dự án TechPulse-AI để các thành viên trong nhóm dễ dàng theo dõi, kiểm thử và đồng bộ mã nguồn.

---

## 1. Tính Năng: Xóa Phiên Hỏi Đáp Đơn Lẻ (Single Q&A Session Deletion)

### Bối cảnh & Lý do thay đổi
- **Trước khi sửa:** Giao diện Hỏi đáp (Q&A) chỉ có một nút *"Xóa tất cả phiên"*. Người dùng không thể xóa một phiên chat cụ thể mà phải xóa toàn bộ lịch sử nếu không muốn giữ một cuộc trò chuyện nào đó.
- **Nhu cầu:** Cung cấp nút `×` (xóa riêng lẻ) trên từng phiên trong danh sách bên trái để người dùng quản lý lịch sử trò chuyện linh hoạt hơn.
- **Khảo sát Backend:** Endpoint `DELETE /api/v1/chat-sessions/{chatSessionId}` đã có sẵn và hoàn thiện đầy đủ trong router, service và repository, chỉ thiếu tích hợp trên Frontend.

### Chi tiết thay đổi mã nguồn
1. **Frontend Integration Hook (`client/app/integration/use-public-integration.js`):**
   - Thêm hàm `deleteSession(targetSessionId)` trong hook `useQa`.
   - Quản lý `epochRef` để tránh race condition khi người dùng xóa nhanh.
   - Gọi `qaApi.deleteSession(sessionId, csrfToken)`.
   - Cập nhật state `sessions` ngay lập tức trên UI.
   - Nếu phiên bị xóa đang là phiên active đang mở: tự động reset màn hình chat về trạng thái trống (`empty`) và tạo session mới khi người dùng gửi câu hỏi tiếp theo.
   - Cung cấp handler `handlers.onDeleteSession` cho View.
2. **Giao diện người dùng (`client/features/public/views/QaView.jsx`):**
   - Tái cấu trúc từng item trong danh sách phiên thành `.public-session-item` chứa 2 phần:
     - Nút chọn phiên `.public-session-select` (đổi phiên khi click).
     - Nút xóa riêng lẻ `.public-session-delete` hiển thị ký tự `×`, có đầy đủ `title="Xóa phiên này"` và `aria-label`.
     - Sử dụng `event.stopPropagation()` trên nút xóa để tránh việc kích hoạt sự kiện chọn phiên khi người dùng bấm xóa.
3. **Định kiểu CSS (`client/features/public/public-components.css`):**
   - Bố cục flexbox cho `.public-session-item`, căn chỉnh nút xóa ở góc phải.
   - Hiệu ứng hover cho nút xóa: nền chuyển sang `--public-danger-soft` và icon chuyển sang `--public-danger` (màu đỏ cảnh báo nhẹ nhàng).
   - Hỗ trợ màn hình cảm ứng (`@media (hover: none)`) để nút xóa luôn hiển thị rõ ràng.
4. **Kiểm thử tự động:**
   - `test/client/qa-session-lifecycle.test.js`: Bổ sung unit test cho việc xóa phiên active và phiên không active (`11/11 passed`).
   - `test/ui/public/public-coverage.test.js`: Bổ sung test kiểm tra render nút xóa và mock handler (`5/5 passed`).

---

## 2. Cải Tiến: Dropdown Chọn Chủ Đề Trong Tìm Kiếm (Search Topic Selection Dropdown)

### Bối cảnh & Lý do thay đổi
- **Trước khi sửa:** Trong trang Tìm kiếm (`SearchView.jsx`), trường "Chủ đề" là một ô nhập tự do (`<FilterField id="public-search-topic" />`).
  - Người dùng không biết hệ thống có những chủ đề nào để gõ.
  - Dễ gặp lỗi chính tả (ví dụ gõ *"trí tuệ nhân tạo"* thay vì *"AI"*) dẫn đến database không khớp tag và trả về kết quả rỗng.
  - Cho phép gõ chuỗi ký tự rác vào bộ lọc.
- **Giải pháp:** Chuyển đổi trường nhập chủ đề sang Dropdown `<select>` lựa chọn từ danh mục chủ đề chuẩn của dự án.

### Chi tiết thay đổi mã nguồn
1. **Giao diện người dùng (`client/features/public/views/SearchView.jsx`):**
   - Import danh mục chủ đề chuẩn: `import { TOPICS } from '../components/reader-format.js'`.
   - Bổ sung prop mặc định `topics = TOPICS` vào component `SearchView`.
   - Thay thế thẻ `<FilterField id="public-search-topic" ... />` bằng cấu trúc Dropdown:
     ```jsx
     <label className="public-field" htmlFor="public-search-topic">
       <span>Chủ đề</span>
       <select
         id="public-search-topic"
         className="public-input"
         value={current.topic}
         onChange={(event) => handlers.onQueryChange?.('topic', event.target.value)}
       >
         <option value="">Tất cả chủ đề</option>
         {topics.map((topic) => (
           <option key={topic} value={topic}>
             {topic}
           </option>
         ))}
       </select>
     </label>
     ```
   - Sử dụng chung lớp CSS `.public-field` và `.public-input`, đồng bộ 100% về kích thước, bo góc, màu viền với dropdown *"Chế độ"* ngay bên cạnh.
2. **Luồng dữ liệu (Data Flow):**
   - Khi chọn `"Tất cả chủ đề"`: `current.topic` mang giá trị rỗng `""`, backend tìm kiếm trên toàn bộ bài viết trong DB.
   - Khi chọn một chủ đề cụ thể (ví dụ `"AI"`, `"Cloud"`, `"Security"`...): backend lọc chính xác các bài viết có tag tương ứng.
   - Hợp đồng API (`GET /api/v1/search-results?topic=...`) và Backend logic được giữ nguyên vẹn, không gây breaking change.
3. **Kiểm thử tự động:**
   - `test/ui/public/user-flow-fixes.test.js`: Thêm test case `renders the topic search filter as a select dropdown with active topics` kiểm tra select element, option mặc định và các option chủ đề chuẩn.

---

## 3. Cải Tiến: Chuyển Đổi Trường Nguồn Sang Dropdown Tên Thân Thiện Trong Tìm Kiếm (Source Selection Dropdown)

### Bối cảnh & Lý do thay đổi
- **Trước khi sửa:** Trang Tìm kiếm có trường "Nguồn" (`<FilterField id="public-search-source" />`) là ô nhập text tự do yêu cầu người dùng phải tự gõ chuỗi ID Hex 24 ký tự của MongoDB (ví dụ: `6a941065da5d918e06f16d55`).
  - Người dùng không thể biết hay nhớ được mã ID này để gõ.
  - Nếu nhập tên nguồn (như *"The Verge"*), hệ thống tìm theo ID nên không khớp bài nào.
- **Giải pháp:** Chuyển đổi thành Dropdown `<select id="public-search-source">` hiển thị tên nguồn thân thiện cho người đọc (*Google AI Blog, The Verge, arXiv, Hacker News...*), đồng bộ 100% với giao diện bộ lọc bên trang Feed. Giá trị `source.id` được quản lý ngầm khi gửi request lên backend.

### Chi tiết thay đổi mã nguồn
1. **Giao diện người dùng (`client/features/public/views/SearchView.jsx`):**
   - Thêm các hàm helper `sourceOption`, `articleSource`, `collectSourceItems` để trích xuất và tổng hợp danh sách nguồn từ prop `sources` và từ kết quả tìm kiếm (`results`).
   - Tiếp nhận prop `sources = []` từ shell tích hợp.
   - Thêm dropdown chọn nguồn vào thanh bộ lọc:
     ```jsx
     <label className="public-field" htmlFor="public-search-source">
       <span>Nguồn</span>
       <select
         id="public-search-source"
         className="public-input"
         value={current.sourceId}
         onChange={(event) => handlers.onQueryChange?.('sourceId', event.target.value)}
       >
         <option value="">Tất cả nguồn</option>
         {sourceItems.map((source) => (
           <option key={source.id} value={source.id}>
             {source.name || source.id}
           </option>
         ))}
       </select>
     </label>
     ```
2. **Truyền dữ liệu từ Shell ứng dụng (`client/features/public/PublicApp.jsx`):**
   - Truyền danh sách `sources` từ `feed.sources` (hoặc `search.sources`) sang viewProps của `SearchView`:
     `search: { ...search, sources: search.sources || feed.sources || [], ...shared }`.
3. **Kiểm thử tự động:**
   - `test/ui/public/user-flow-fixes.test.js`:
     - Thêm test case `renders the source search filter as a select dropdown with human-readable source names`.
     - Thêm test case `renders source options in search from results when sources prop is empty`.

---

## 4. Cải Tiến: Loại Bỏ Ô Nhập ID Bài Viết Thủ Công Trong Hỏi Đáp (Q&A Article Scope UX)

### Bối cảnh & Lý do thay đổi
- **Trước khi sửa:** Trong cột "Phạm vi nguồn" của tab Hỏi đáp (`QaView.jsx`), có một trường nhập tự do `<FilterField id="public-qa-article" label="Giới hạn theo bài" />`. Người dùng thông thường không thể biết và không thể nhớ mã ID MongoDB của bài viết để tự tay gõ vào đây.
- **Giải pháp:**
  - Xóa bỏ ô nhập ID thủ công `FilterField id="public-qa-article"` khỏi giao diện.
  - Khi người dùng bấm nút *"Hỏi đáp"* từ một bài viết cụ thể (trên Feed hoặc trang chi tiết bài viết), hệ thống tự động gán `articleId` và hiển thị thẻ ngữ cảnh nổi bật `.public-qa-article-selected`:
    *"Đang hỏi về bài viết cụ thể: [ID/Mã bài] [Nút Bỏ chọn]"*.
  - Người dùng có thể bấm *"Bỏ chọn"* bất cứ lúc nào để quay lại phạm vi hỏi đáp theo toàn bộ chủ đề/thời gian.

### Chi tiết thay đổi mã nguồn
1. **Giao diện người dùng (`client/features/public/views/QaView.jsx`):**
   - Loại bỏ component `<FilterField id="public-qa-article" ... />`.
   - Giữ nguyên khối hiển thị ngữ cảnh bài viết đang chọn `{safeScope.articleId ? <div className="public-qa-article-selected">...</div> : null}`.
   - Cập nhật dòng nhắc gợi ý `public-qa-scope-hint`:
     *"Chọn ít nhất một chủ đề hoặc cung cấp đủ hai mốc thời gian trước khi hỏi."*
2. **Kiểm thử tự động:**
   - Cập nhật test case trong `test/ui/public/public-coverage.test.js` đồng bộ với nội dung gợi ý mới (`154/154 tests passed`).

---

## 5. Cải Tiến: Câu Hỏi Mẫu & Hướng Dẫn Thân Thiện Khi Chưa Đủ Bằng Chứng (Q&A Suggested Prompts & Refusal Guidance)

### Bối cảnh & Lý do thay đổi
- **Trước khi sửa:**
  - Khi mở tab Hỏi đáp lần đầu, màn hình trống chỉ có thông báo ngắn, người dùng không biết hệ thống đã thu thập những tin tức/chủ đề nào để đặt câu hỏi.
  - Khi người dùng đặt câu hỏi mà hệ thống không có bài viết liên quan hoặc dữ liệu không đủ để AI trả lời (do các nguồn tin là `metadata-only`), hệ thống chỉ hiển thị đúng một câu: *"Chưa đủ bằng chứng để trả lời câu hỏi này."* Người dùng dễ hiểu lầm là tính năng bị lỗi hoặc không hiểu cơ chế RAG có kiểm chứng.
- **Giải pháp:**
  - **Câu hỏi mẫu (Suggested Prompts):** Hiển thị danh sách các thẻ câu hỏi mẫu kèm tag chủ đề ngay tại màn hình bắt đầu của Q&A. Người dùng chỉ cần click vào là câu hỏi tự động được điền và tự động kích hoạt chủ đề tương ứng để trải nghiệm ngay.
  - **Hướng dẫn thân thiện khi thiếu bằng chứng:** Bổ sung lời giải thích rõ ràng và các mẹo gợi ý hành động (khám phá Feed, xem Tìm kiếm, mở rộng phạm vi chủ đề/thời gian) để người dùng nắm rõ cơ chế và biết cách thử lại.

### Chi tiết thay đổi mã nguồn
1. **Giao diện người dùng (`client/features/public/views/QaView.jsx`):**
   - Thêm mảng `SUGGESTED_PROMPTS` với các câu hỏi thực tế dựa trên nguồn tin công nghệ trong hệ thống.
   - Thêm hàm `handleSelectSuggestion` tự động điền câu hỏi và kích hoạt chủ đề nếu chưa chọn.
   - Hiển thị `.public-qa-empty-wrap` gồm `StateCard` và danh sách `.public-suggestion-chips`.
   - Nâng cấp bong bóng từ chối `.public-refusal-bubble`: hiển thị thông báo chính kèm khối hướng dẫn chi tiết `.public-refusal-guidance` khi `refusalReason === 'insufficient-evidence'`.
2. **Định kiểu CSS (`client/features/public/public-components.css`):**
   - Định kiểu cho `.public-suggestion-chip`, `.public-suggestion-tag`, `.public-suggestion-text` với hiệu ứng hover mượt mà.
   - Định kiểu cho `.public-refusal-bubble`, `.public-refusal-title`, `.public-refusal-guidance`, `.public-refusal-tips`.
3. **Kiểm thử tự động:**
   - `test/ui/public/user-flow-fixes.test.js`:
     - Thêm test `renders suggested prompt chips in the Q&A empty state`.
     - Thêm test `renders helpful guidance when a Q&A answer is refused due to insufficient evidence`.
   - Toàn bộ `156/156 tests passed`.

---

## 6. Cải Tiến: Thay Thế ID Bài Viết Bằng Thẻ Ngữ Cảnh Đầy Đủ & Nút Hỏi Đáp Trực Tiếp Trên Card (Rich Article Context Card & Direct Q&A Action)

### Bối cảnh & Lý do thay đổi
- **Trước khi sửa:**
  - Khi người dùng điều hướng vào Hỏi đáp từ một bài viết (hoặc qua URL `/qa?articleId=...`), thanh phạm vi nguồn chỉ hiển thị một dòng thô sơ: `Đang hỏi về bài: [mã hex dài 24 ký tự] [Bỏ chọn]`. Người dùng không biết bài viết đó có tiêu đề gì, nguồn nào, ngày nào hay tóm tắt nội dung ra sao.
  - Trên các thẻ bài viết ở **Bảng tin (Feed)**, **Tìm kiếm (Search)**, và **Bài đã lưu (Saved)**, chỉ có các nút *"Lưu bài"* và *"Đọc chi tiết"*, chưa có nút *"Hỏi đáp"* trực tiếp để người dùng có thể hỏi AI về bài viết đó ngay từ danh sách.
- **Giải pháp:**
  - **Thẻ ngữ cảnh bài viết đầy đủ (`.public-qa-article-context`):** Thay thế hoàn toàn phần hiển thị mã ID bằng một card thông tin trực quan hiển thị:
    - Badge *"Đang hỏi về bài viết"* cùng nút *"Bỏ chọn"* nhanh.
    - Tiêu đề bài viết (tiếng Việt hoặc tiêu đề gốc).
    - Metadata: Tên nguồn tin và ngày xuất bản đã định dạng.
    - Đoạn tóm tắt nội dung (`summaryVi`) giúp người dùng nắm bắt ngữ cảnh đang hỏi.
    - Trường hợp người dùng truy cập trực tiếp qua URL mà chưa có sẵn object bài viết trong state, hook `useQa` sẽ tự động fetch chi tiết bài viết qua `contentApi.getArticle(initialArticleId)` để điền đầy đủ dữ liệu vào thẻ; đồng thời có fallback hiển thị mã bài viết ngắn gọn nếu đang tải.
  - **Nút "Hỏi đáp" trực tiếp trên ArticleCard:** Bổ sung nút *"Hỏi đáp"* vào danh sách hành động của `ArticleCard` tại mọi màn hình (Feed, Search, Saved). Khi bấm vào, hệ thống tự động lưu trữ ngữ cảnh bài viết và điều hướng sang tab Hỏi đáp với phạm vi nguồn đã được khóa vào bài viết đó.

### Chi tiết thay đổi mã nguồn
1. **Giao diện Hỏi đáp (`client/features/public/views/QaView.jsx`):**
   - Import `articleTitle`, `sourceName` từ `reader-format.js`.
   - Thay thế khối hiển thị mã ID bằng `.public-qa-article-context` gồm header badge, tiêu đề bài viết, nguồn, ngày xuất bản và tóm tắt.
   - **Tối ưu ngữ cảnh phiên trống (Empty State):** Khi có `safeScope.articleId`, ẩn danh sách câu hỏi gợi ý mẫu chung toàn hệ thống (`SUGGESTED_PROMPTS`), đổi tiêu đề `StateCard` thành *"Hỏi đáp về bài viết"* và đổi placeholder ô nhập thành *"Nhập câu hỏi về bài viết này"*. Chỉ hiển thị danh sách câu hỏi mẫu khi người dùng không chọn bài viết cụ thể (hỏi chung toàn hệ thống).
2. **Thành phần thẻ bài viết (`client/features/public/components/reader-primitives.jsx`):**
   - Thêm prop `onAskAboutArticle` vào component `ArticleCard`.
   - Bổ sung nút bấm `<button className="public-text-action" onClick={() => onAskAboutArticle(article)}>Hỏi đáp</button>` trong `.public-card-actions`.
3. **Các màn hình danh sách (`FeedView.jsx`, `SearchView.jsx`, `SavedView.jsx`):**
   - Truyền handler `handlers.onAskAboutArticle` xuống từng `ArticleCard`.
4. **Integration Hook (`client/app/integration/use-public-integration.js`):**
   - Cập nhật `qaScopeForArticle` để giữ lại thuộc tính `article` trong scope khi chuyển đổi phạm vi.
   - Nâng cấp `articleAskHandler` nhận object bài viết đầy đủ và gọi `qa.handlers.onScopeArticleId(targetArticle)`.
   - Truyền `onAskAboutArticle: articleAskHandler` vào `useFeed`, `useSearch`, `useSaved`, `useArticle`.
   - Nâng cấp `useQa`: hỗ trợ `contentApi` để tự động nạp thông tin bài viết khi mở tab qua query param `/qa?articleId=...`; cập nhật `onScopeArticleId` nhận cả object bài viết và `onClearArticleScope` dọn dẹp sạch sẽ cả `articleId` lẫn `article`.
5. **Định kiểu CSS (`client/features/public/public-components.css`):**
   - Bổ sung định kiểu cho `.public-qa-article-context`, `.public-qa-article-context-head`, `.public-qa-article-context-badge`, `.public-qa-article-context-title`, `.public-qa-article-context-meta`, `.public-qa-article-context-summary`.
6. **Kiểm thử tự động (`test/ui/public/user-flow-fixes.test.js`):**
   - Thêm test `renders rich article context card in Q&A when asking about an article and hides generic suggested prompts`.
   - Thêm test `renders fallback article context in Q&A when only articleId is provided`.
   - Thêm test `renders direct Hỏi đáp button on feed article cards when handler is supplied`.
   - Thêm test `renders direct Hỏi đáp button on search and saved article cards when handler is supplied`.
   - Toàn bộ `160/160 tests passed`.

---

## 7. Cải Tiến: Phân Nhóm 10 Nguồn Theo 3 Connector (RSS, arXiv, Hacker News) Bằng `<optgroup>` Trong Tìm Kiếm & Bảng Tin

### Bối cảnh & Lý do thay đổi
- **Trước khi sửa:**
  - Dropdown nguồn ở trang Tìm kiếm (`SearchView.jsx`) và Bảng tin (`FeedView.jsx`) lấy dữ liệu động từ `feed.sources`.
  - Do `feed.sources` chỉ nạp từ 10 bài viết mới nhất của feed, dropdown thực tế chỉ hiển thị vỏn vẹn **3 nguồn** ngẫu nhiên (*The Verge demo, Hacker News Top Stories, Hacker News demo*). 7 nguồn còn lại trong MongoDB bị thiếu hoàn toàn.
  - Hệ thống chưa có public endpoint `/api/v1/sources` cho người đọc thông thường (chỉ có endpoint `/api/v1/admin/sources` của admin).
- **Yêu cầu của nhóm trưởng:**
  - Kiến trúc hệ thống thu thập tin tức được tổ chức xoay quanh **3 Connector** chính: `rss`, `arxiv`, và `hacker-news`.
  - Không hardcode cố định 3 nguồn demo mà phải hiển thị đầy đủ danh mục nguồn theo từng Connector tương ứng để người dùng dễ định vị và tra cứu.
  - Giữ nguyên hợp đồng API backend (`sourceId` gửi lên vẫn là ObjectId của MongoDB, không gây breaking change OpenAPI).

### Chi tiết thay đổi mã nguồn
1. **Danh mục nguồn & Helper phân nhóm (`client/features/public/components/reader-format.js`):**
   - Khai báo nhãn hiển thị cho connector `CONNECTOR_LABELS`:
     - `rss`: `'RSS Feeds'`
     - `arxiv`: `'arXiv'`
     - `'hacker-news'`: `'Hacker News'`
   - Xây dựng danh mục chuẩn `SOURCE_CATALOG` gồm đầy đủ 10 nguồn trong database kèm `id`, `name`, `sourceKey`, `connectorType`:
     - **RSS Feeds:** *The Verge Technology, Ars Technica, Google DeepMind Blog, OpenAI News, Hugging Face Blog, The Verge Technology demo*.
     - **arXiv:** *arXiv Computer Science AI, arXiv Computer Science AI demo*.
     - **Hacker News:** *Hacker News Top Stories, Hacker News Top Stories demo*.
   - Bổ sung hàm helper:
     - `resolveSourceConnector(source)`: Nhận diện connector của nguồn dựa trên `connectorType` hoặc suy diễn từ `sourceKey`/`domain`.
     - `groupSourcesByConnector(sourceItems)`: Gom danh sách nguồn thành các nhóm chuẩn bị sẵn cho thẻ `<optgroup>`.
2. **Giao diện Tìm kiếm (`client/features/public/views/SearchView.jsx`):**
   - Hàm `collectSourceItems` nạp `SOURCE_CATALOG` làm danh sách khởi tạo, sau đó tự động merge bổ sung bất kỳ nguồn động nào từ `sources` prop hoặc `results`.
   - Cấu trúc lại thẻ `<select id="public-search-source">` với các nhóm `<optgroup label="...">`:
     ```jsx
     <select id="public-search-source" className="public-input" value={current.sourceId} onChange={...}>
       <option value="">Tất cả nguồn</option>
       {sourceGroups.map((group) => (
         <optgroup key={group.key} label={group.label}>
           {group.items.map((source) => (
             <option key={source.id} value={source.id}>
               {source.name || source.id}
             </option>
           ))}
         </optgroup>
       ))}
     </select>
     ```
   - Giữ nguyên `value={source.id}` để backend lọc chính xác bài viết bằng `sourceId` mà không làm thay đổi OpenAPI contract.
3. **Giao diện Bảng tin (`client/features/public/views/FeedView.jsx`):**
   - Đồng bộ logic phân nhóm `<optgroup>` theo 3 Connector cho dropdown lọc nguồn ở trang Bảng tin.
4. **Kiểm thử tự động (`test/ui/public/user-flow-fixes.test.js`):**
   - Bổ sung test `renders grouped source options by connector in search view` kiểm tra nhãn `<optgroup>` của cả 3 connector và các nguồn chuẩn.
   - Bổ sung test `renders grouped source options by connector in feed view`.
   - Kết quả: `20/20 tests passed`.

---

## 8. Cải Tiến: Tự Động Đặt Tiêu Đề Phiên Hỏi Đáp Từ Câu Hỏi Đầu Tiên (First Question Session Title)

### Bối cảnh & Lý do thay đổi
- **Trước khi sửa:** Mọi phiên hỏi đáp mới tạo đều có tiêu đề mặc định là `"Phiên hỏi đáp"`. Khi người dùng có nhiều phiên trò chuyện trong lịch sử, danh sách hiển thị hàng loạt mục trùng tên nhau, rất khó phân biệt nội dung của từng phiên.
- **Giải pháp:** Tự động lấy câu hỏi đầu tiên của người dùng trong phiên, cắt tại ranh giới từ để tiêu đề trả về có tối đa 40 ký tự (đã tính cả dấu ba chấm `…` nếu có).

### Chi tiết thay đổi mã nguồn
1. **Backend Repository (`server/repositories/mongo/chat-repository.js`):**
   - Trong hàm `appendMessage(sessionId, message, options)`: Khi tin nhắn đầu tiên (`role === 'user'`) được thêm vào phiên chat:
     - Kiểm tra nếu phiên hiện tại chưa có tiêu đề riêng hoặc vẫn mang tiêu đề mặc định `"Phiên hỏi đáp"`.
     - Trích xuất nội dung câu hỏi đầu tiên: khi vượt quá giới hạn, dành một ký tự cho dấu ba chấm `…`, cắt phần còn lại tại ranh giới từ và không vượt quá tổng cộng 40 ký tự.
     - Cập nhật trường `title` của phiên trong MongoDB cùng lúc với việc append message, không phát sinh thêm round-trip database.
   - Khi truy vấn `listSessions(userId)`: Trả về trường `title` đã lưu.

---

## 9. Cải Tiến: Phạm Vi Chủ Đề & Multi-Select Dropdown Popover (22 Chủ Đề)

### Bối cảnh & Nhu cầu
- **Trước khi sửa:**
  - Cột bên phải hiển thị nhãn *"Phạm vi nguồn"*, gây hiểu lầm là chọn nguồn báo (RSS, arXiv) trong khi thực chất là giới hạn chủ đề bài viết cần hỏi.
  - Hệ thống chỉ hiển thị một hàng vài nút chủ đề cứng, thiếu rất nhiều chủ đề công nghệ có trong database.
  - Nếu render toàn bộ 22 chủ đề ra sidebar dưới dạng nút bấm thì cột bên phải bị kéo dài ngoằng, vỡ bố cục giao diện.
- **Giải pháp:**
  - Đổi tiêu đề thành **"Phạm vi chủ đề"** kèm mô tả rõ ràng: *"Giới hạn chủ đề và thời gian bài viết cần hỏi đáp."*.
  - Thiết kế Dropdown Popover đa lựa chọn (Multi-Select Popover):
    - Khi đóng: Chỉ hiển thị một nút bấm trigger nhỏ gọn `🏷️ Chọn chủ đề bài viết...` (hoặc `🏷️ Đã chọn (X) chủ đề`).
    - Khi mở: Hiển thị Popover nổi với ô tìm kiếm nhanh, gom nhóm 22 chủ đề theo 8 lĩnh vực công nghệ, có checkbox chọn nhiều chủ đề cùng lúc.
    - Bên dưới trigger có các chip chủ đề đã chọn kèm nút `×` để gỡ nhanh và nút *"Bỏ chọn hết"*.

---

## 10. Khắc Phục Lỗi: Xung Đột Nhãn Giữa Chủ Đề Cha và Con (AI vs Học Máy, Software Engineering vs JavaScript)

### Bối cảnh & Nguyên nhân
- **Hiện tượng lỗi:** Khi người dùng chọn chủ đề `AI` thì mục `Học máy` tự động bị tích chọn theo; khi chọn `Software Engineering` thì mục `JavaScript` tự động bị chọn theo.
- **Nguyên nhân cốt lõi:**
  - Trong `shared/topic-catalog.js`, chủ đề cha `ai-ml` chứa alias `'học máy'`, `'machine learning'` vốn là nhãn chính thức của chủ đề con `machine-learning`.
  - Chủ đề cha `software-engineering` chứa alias `'javascript'`, `'typescript'` vốn thuộc chủ đề con `web-development`.
  - Thuật toán `resolveTopic()` và `topicsMatch()` so sánh canonical ID khiến `'AI'` và `'Học máy'` cùng trỏ về `'ai-ml'`, làm cho `topicsMatch('AI', 'Học máy') === true`.
  - Trong `QaView.jsx`, `isTopicSelected(topic)` kiểm tra `topicsMatch(selected, topic)`, dẫn đến khi chọn một mục thì mục kia bị kích hoạt theo.

### Giải pháp kỹ thuật đã triển khai
1. **Chuẩn hóa danh mục chủ đề (`shared/topic-catalog.js`):**
   - Tách bạch alias: chuyển `'học máy'` về đúng `machine-learning`, chuyển `'javascript'` về đúng `web-development`.
   - Triển khai thuật toán đăng ký alias 3 lượt (**3-pass Registration**):
     - **Pass 1:** Đăng ký danh tính chính thức (`id`, nhãn tiếng Việt/Anh) của TẤT CẢ chủ đề để đảm bảo chủ đề con không bao giờ bị alias của chủ đề cha đè lên.
     - **Pass 2:** Đăng ký alias rộng và mã arXiv cũ của chủ đề cha (giữ tương thích ngược với unit test hiện hữu).
     - **Pass 3:** Đăng ký alias chi tiết của chủ đề con.
2. **Giao diện `QaView.jsx`:**
   - Hoàn toàn độc lập giữa các chủ đề: Chọn `AI` chỉ chọn `AI`, chọn `Software Engineering` chỉ chọn `Software Engineering`.
   - Cho phép chọn riêng lẻ hoặc đồng thời bất kỳ tổ hợp nào.

---

## 11. Cải Tiến: Trải Nghiệm Chờ AI Trả Lời Mượt Mà & Hiệu Ứng Suy Nghĩ (Smooth AI Thinking & Loading UX)

### Bối cảnh & Vấn đề tồn tại
- **Trước khi sửa:**
  1. Khi người dùng nhấn Enter hoặc bấm *"Hỏi với nguồn"*, toàn bộ khung chat cũ bị gỡ khỏi DOM và biến mất đột ngột (`state !== 'ready'`).
  2. Người dùng không thấy câu hỏi mình vừa gửi đi đâu, chỉ thấy một khung Skeleton 3 thanh xám thô ráp thay thế toàn bộ màn hình.
  3. Hiệu ứng chuyển động của khung Skeleton bị lặp giật khấc (do `background-position` từ 100% đến -100% gây hiện tượng giật mỗi chu kỳ 1.4s), tạo cảm giác giao diện bị "đơ" hoặc đứng hình trong lúc chờ mô hình RAG / LLM truy xuất tài liệu và sinh câu trả lời.
  4. Nút bấm chỉ bị disable mà không có phản hồi thị giác nào cho người dùng biết câu hỏi đã được tiếp nhận.

### Chi tiết giải pháp kỹ thuật đã triển khai
1. **Giữ Luồng Trò Chuyện & Hiển Thị Lạc Quan (Optimistic UI Thread):**
   - Lưu trữ câu hỏi vừa gửi (`submittedQuestion`) trong state cục bộ của `QaView.jsx`.
   - Khi chuyển sang `state === 'loading'`: Thay vì ẩn đi toàn bộ luồng chat, component `<MessageThread>` vẫn tiếp tục hiển thị các tin nhắn trước đó (nếu có) kèm:
     - **Bong bóng câu hỏi của người dùng:** Xuất hiện tức thì ở phía dưới với hiệu ứng trượt nhẹ (`fade-slide-up`).
     - **Bong bóng trạng thái AI đang suy nghĩ (`public-message-thinking`):**
       - Badge trạng thái: Icon ✨ lấp lánh nhẹ và nhãn văn bản: `Đang truy xuất nguồn và suy nghĩ...` (bảo đảm tương thích tuyệt đối với các test case kiểm tra chuỗi `"Đang truy xuất nguồn"`).
       - Hiệu ứng 3 chấm nhịp nhàng (`public-thinking-dots`): Chuyển động scale và opacity so le (`animation-delay: 0s, 0.22s, 0.44s`) bằng hàm gia tốc `cubic-bezier(0.4, 0, 0.2, 1)`.
       - Dải sóng shimmer phát sáng (`public-thinking-shimmer-bar`): Lướt nhẹ nhàng bên dưới thông báo tiến trình.
   - Tự động cuộn mượt (`scrollIntoView({ behavior: 'smooth' })`) xuống cuối luồng chat khi xuất hiện câu hỏi mới hoặc hiệu ứng suy nghĩ.
   - Khi dữ liệu từ backend trả về và chuyển sang `state === 'ready'`, bong bóng tạm thời được thay thế mượt mà bằng nội dung câu trả lời thật kèm trích dẫn nguồn.

2. **Nâng Cấp Khung Skeleton Mượt Mà Không Giật:**
   - Cải tiến `.public-skeleton` trong `client/features/public/public-components.css`:
     - Sử dụng pseudo-element `::after` với lớp gradient trong suốt lướt qua (`transform: translateX(-100%)` đến `translateX(100%)`) được tăng tốc phần cứng (GPU hardware acceleration), loại bỏ hoàn toàn hiện tượng gián đoạn / giật khấc.
     - Các thanh Skeleton bên trong được bổ sung hiệu ứng thở (`pulse`) so le mềm mại.

3. **Phản Hồi Thị Giác Trên Nút Gửi:**
   - Trong lúc `state === 'loading'`, nút *"Hỏi với nguồn"* hiển thị trạng thái `Đang trả lời...` cùng spinner xoay mượt mà, giúp người dùng an tâm rằng hệ thống đang xử lý prompt của họ.

4. **Hỗ Trợ Tối Đa Trợ Năng (Accessibility):**
   - Đầy đủ thuộc tính `aria-busy="true"`, `aria-live="polite"`.
   - Bổ sung truy vấn `@media (prefers-reduced-motion: reduce)` để tự động tắt hiệu ứng lặp đối với người dùng bật chế độ giảm chuyển động trong hệ điều hành.

---

## 12. Cải Tiến: Đầy Đủ 22 Chủ Đề Phân Nhóm 8 Lĩnh Vực & Tìm Kiếm Nhanh Trong Cài Đặt Tài Khoản (Account Preferences)

### Bối cảnh & Vấn đề tồn tại
- **Trước khi sửa:**
  - Trong trang **Cài đặt tài khoản** (`AccountView.jsx`), mục *"Chủ đề quan tâm"* chỉ mặc định import danh sách `TOPICS` từ `reader-format.js` (chỉ lọc `kind: 'parent'`).
  - Hệ thống **chỉ hiển thị 8 chủ đề cha** (`AI`, `AI Agent`, `Robotics`, `Software Engineering`, `DevOps`, `Bảo mật`, `Dữ liệu`, `Blockchain`), hoàn toàn thiếu 14 chủ đề con đã có trong cơ sở dữ liệu MongoDB và taxonomy chuẩn của dự án (`machine-learning`, `deep-learning`, `agentic-systems`, `robot-control`, `web-development`, `system-architecture`, `cloud-infrastructure`, `containers-orchestration`, `appsec`, `cryptography`, `databases`, `data-engineering`, `blockchain-web3`, `quantum-computing`).
  - Người dùng không có cách nào lựa chọn các chuyên ngành cụ thể (ví dụ: *Học máy*, *Học sâu & LLM*, *Container & Kubernetes*, *Cơ sở dữ liệu*...) để Feed ưu tiên.
  - Thiếu ô tìm kiếm nhanh và thiếu bộ đếm số lượng chủ đề đã chọn so với giới hạn 20 chủ đề của hệ thống.

### Giải pháp kỹ thuật đã triển khai
1. **Hiển thị đầy đủ 22 chủ đề chuẩn hóa theo 8 lĩnh vực công nghệ:**
   - Cập nhật `AccountView.jsx` mặc định sử dụng `ALL_TOPICS` và `GROUPED_TOPICS` từ `reader-format.js`.
   - Gom nhóm khoa học theo 8 lĩnh vực công nghệ:
     1. **AI & Machine Learning:** *AI* (Chính), *Học máy*, *Học sâu & LLM*
     2. **AI Agent & Hệ thống tự hành:** *AI Agent* (Chính), *Hệ thống Agentic*
     3. **Robotics & Tự động hóa:** *Robotics* (Chính), *Điều khiển Robot*
     4. **Kỹ thuật phần mềm & Lập trình:** *Software Engineering* (Chính), *JavaScript*, *Kiến trúc hệ thống*
     5. **DevOps & Điện toán đám mây:** *DevOps* (Chính), *Hạ tầng Cloud & SRE*, *Container & Kubernetes*
     6. **An ninh mạng & Bảo mật:** *Bảo mật* (Chính), *Bảo mật ứng dụng*, *Mật mã học & Quyền riêng tư*
     7. **Khoa học máy tính & Dữ liệu:** *Dữ liệu* (Chính), *Cơ sở dữ liệu*, *Kỹ nghệ dữ liệu*
     8. **Công nghệ mới nổi & Web3:** *Blockchain* (Chính), *Blockchain & Web3*, *Điện toán lượng tử*
   - Chủ đề chính (parent topic) có badge tag `Chính` để phân biệt rõ ràng với các chủ đề con (leaf topics).
   - Giữ lại nhóm *"Chủ đề khác"* cho các chủ đề tùy chỉnh hoặc alias cũ của tài khoản (`unknownSelected` như `CustomTopic`), đảm bảo không mất dữ liệu lịch sử.

2. **Bộ đếm trực quan & Ô tìm kiếm nhanh:**
   - Thêm thanh công cụ `.public-preference-toolbar` với bộ đếm: `Đã chọn: X/20 chủ đề` (tương ứng giới hạn 20 chủ đề trong OpenAPI schema và MongoDB validator).
   - Nút *"Bỏ chọn hết"* xuất hiện khi có ít nhất 1 chủ đề đang chọn.
   - Ô tìm kiếm nhanh: Lọc tức thì các nhóm và chủ đề khớp từ khóa (không phân biệt hoa thường, hỗ trợ tiếng Việt có dấu).

3. **Tương thích ngược tuyệt đối:**
   - Nếu prop `topics` được truyền vào dưới dạng danh sách tùy chỉnh (ví dụ trong các bài test `topics: ['AI', 'Cloud']`), component tự động chuyển sang hiển thị danh sách phẳng tương thích hoàn toàn.
   - Thuật toán `isTopicSelected` và `toggleTopicValue` phân biệt rõ ràng giữa chủ đề cha và con: chọn `Học máy` chỉ kích hoạt `Học máy`, không làm `AI` bị kích hoạt nhầm.

4. **Kiểm thử xác minh:**
   - Thêm test case `renders all 22 active topics across 8 product domains, search input and selection counter in AccountView` trong `test/ui/public/public-components.test.js`.
   - Toàn bộ test suite liên quan đều pass 100%.

---

## 13. Cải Tiến: Đóng Gói Form Đổi Mật Khẩu, Modal Popup Đếm Ngược 5 Giây & Xử Lý F5 Reload Tự Động Đăng Xuất (Account Password Management)

### Bối cảnh & Yêu cầu cải tiến
- **Trước khi sửa:**
  - Trong trang Cài đặt tài khoản (`AccountView.jsx`), mục *"Đổi mật khẩu"* (hoặc *"Đặt mật khẩu"*) luôn hiển thị sẵn toàn bộ các trường nhập liệu ngay trong thẻ, làm giao diện bị rối.
  - Sau khi đổi mật khẩu thành công, thông báo hiển thị inline hoặc biến mất nhanh, phiên đăng nhập vẫn ở trạng thái cũ khiến người dùng không rõ đã đổi thành công chưa.
  - Người dùng mong muốn có popup thông báo thành công trực quan với bộ đếm ngược rõ ràng (5 giây), cho phép bấm đăng xuất ngay bất cứ lúc nào, và nếu người dùng không bấm đăng xuất mà tải lại trang (F5) thì hệ thống vẫn tự động đăng xuất ngay lập tức.

### Giải pháp kỹ thuật đã triển khai
1. **Đóng gói form vào nút kích hoạt (Toggle Activation Button):**
   - Mặc định, thẻ Bảo mật chỉ hiển thị tiêu đề, mô tả và một nút bấm duy nhất: **"Đổi mật khẩu"** (hoặc **"Đặt mật khẩu"** đối với tài khoản Google-only chưa có mật khẩu).
   - Khi người dùng bấm vào nút, form nhập liệu mới mở ra với các trường tương ứng.
   - Bổ sung nhóm nút thao tác `.public-password-actions` gồm:
     - Nút **"Xác nhận"**: Thực hiện kiểm tra tính hợp lệ và gọi API đổi mật khẩu.
     - Nút **"Hủy"**: Đóng form và xóa sạch dữ liệu vừa nhập, khôi phục lại trạng thái gọn gàng ban đầu.

2. **Modal Dialog Thông Báo Thành Công, Bộ Đếm Ngược 5 Giây & Xử Lý F5 Reload Tự Động Đăng Xuất:**
   - **Modal Dialog chuẩn trợ năng (`role="dialog"`, `aria-modal="true"`):**
     - Khi đổi/đặt mật khẩu thành công, thay vì thông báo inline nhỏ dễ bị trôi, một Modal Dialog nổi bật hiện ra giữa màn hình với phông nền mờ (`.public-dialog-backdrop`).
     - Quản lý tiêu điểm an toàn với hook `useDialogFocus`, hỗ trợ phím `Escape` để kích hoạt đăng xuất ngay.
   - **Bộ đếm ngược trực quan 5 giây (5s -> 0s):**
     - Trong nội dung dialog hiển thị số giây đếm ngược nổi bật: `Hệ thống sẽ tự động đăng xuất sau {countdown} giây để bạn đăng nhập lại bằng mật khẩu mới.`.
     - Nút hành động chính hiển thị trực tiếp số giây đếm lùi: `Đăng xuất ngay ({countdown}s)`.
     - Người dùng có thể chủ động bấm `Đăng xuất ngay ({countdown}s)` bất kỳ lúc nào để chuyển hướng ngay lập tức mà không phải chờ hết 5 giây.
     - Sau khi hết 5 giây, hệ thống tự động kích hoạt đăng xuất.
   - **Xử lý Reload trang (F5) tự động đăng xuất an toàn:**
     - Nếu trong thời gian 5 giây đếm ngược, người dùng không bấm đăng xuất mà tải lại trang (F5):
       - Ở tầng `client/App.jsx`, callback `handlePasswordChangeSuccess` lưu cờ tạm `techpulse_pending_logout` vào `sessionStorage`.
       - Khi trang reload lại, hàm `loadSession` trong `App.jsx` phát hiện cờ `techpulse_pending_logout`.
       - Hệ thống tự động xóa cờ, gọi `api.logout({ credentials: 'same-origin' })` để thu hồi cookie phiên trên server và cập nhật `applySession(null, null, notice)` đưa người dùng về trạng thái khách (`guest`).
       - Người dùng lập tức được đăng xuất về trang chủ kèm banner thông báo màu xanh *"Đổi mật khẩu thành công. Vui lòng đăng nhập lại bằng mật khẩu mới."*, triệt để ngăn chặn tình trạng bị kẹt lại phiên đăng nhập cũ.
   - **Tuân thủ quy tắc phân tầng kiến trúc (`app-integration.test.js`):**
     - Các thư mục presentation (`client/features/public`, `client/features/admin/ui`, `client/app/integration`) hoàn toàn không chứa từ khóa `sessionStorage`. Toàn bộ việc lưu và xóa cờ reload được đóng gói tập trung duy nhất tại Root component `client/App.jsx`.

3. **Kiểm thử xác minh:**
   - Cập nhật test case `renders the change-password form with a current-password field for accounts that already have a password` và `switches to first-time password setup without a current-password field for Google-only accounts` sử dụng `initialPasswordOpen: true`.
   - Bổ sung test case `hides the change-password form behind an activate button by default in AccountView` trong `test/ui/public/public-components.test.js`.
   - Bổ sung test case `renders a success pop-up modal dialog with auto-logout countdown when password change succeeds` kiểm tra modal dialog với bộ đếm 5 giây và nút `Đăng xuất ngay (5s)` trong `test/ui/public/public-components.test.js`.
   - Bổ sung test case `commits the rotated session after a password change and omits currentPassword for first-time setup` xác minh `onPasswordChangeSuccess` được gọi với thông báo tương ứng trong `test/client/session-actions.test.js`.
   - Toàn bộ các bộ test (`public-components.test.js`, `session-actions.test.js`, `app-integration.test.js`, `public-integration-coverage.test.js`) đều pass 100%.

---

## 14. Cải Tiến: Xác Thực Tài Khoản Đa Tầng Trước Khi Xóa Vĩnh Viễn (Email Verification, Risk Confirmation & Safety Countdown Delay)

### Bối cảnh & Yêu cầu cải tiến
- **Trước khi sửa:**
  - Trong trang Cài đặt tài khoản (`AccountView.jsx`), phần *"Quản lý dữ liệu"* có nút *"Yêu cầu xóa tài khoản"*. Khi bấm vào, chỉ có một hộp thoại xác nhận đơn giản với hai nút *"Quay lại"* và *"Xác nhận xóa"*.
  - Người dùng có thể vô tình bấm nhầm và tài khoản bị xóa vĩnh viễn ngay lập tức mà không có cơ chế xác thực danh tính chủ tài khoản hay thời gian chờ an toàn.
- **Giải pháp được thống nhất:**
  - Kết hợp **Ý tưởng 1 (Xác thực Email & Checkbox cam kết)** và **Ý tưởng 3 (Thời gian chờ an toàn 5 giây - Safety Countdown Delay)** tạo ra cơ chế phòng ngừa đa tầng theo tiêu chuẩn bảo mật nghiêm ngặt nhất (tương tự GitHub, AWS, Google Cloud):
    1. **Hộp cảnh báo nguy hiểm (`.public-deletion-warning-box`):** Nổi bật màu đỏ viền đậm thông báo toàn bộ dữ liệu, lịch sử và tùy chọn cá nhân sẽ bị hủy vĩnh viễn và không thể khôi phục.
    2. **Xác thực Email chủ sở hữu (`#account-deletion-email`):** Bắt buộc người dùng phải gõ chính xác địa chỉ email của tài khoản đang đăng nhập (`user.email`). Nếu gõ sai hoặc chưa gõ đủ thì nút xóa bị khóa.
    3. **Checkbox cam kết rủi ro (`#account-deletion-risk-confirm`):** Người dùng phải chủ động tích chọn: *"Tôi hiểu và đồng ý xóa vĩnh viễn tài khoản này cùng toàn bộ dữ liệu liên quan."*.
    4. **Bộ đếm an toàn 5 giây (`Safety Countdown Delay`):** Ngay khi mở modal dialog, kích hoạt bộ đếm thời gian 5 giây an toàn (5s -> 4s -> 3s -> 2s -> 1s -> 0s). Trong 5 giây này, nút bấm hiển thị trạng thái `Xác nhận xóa ({countdown}s)` và bị khóa hoàn toàn (`disabled`), buộc người dùng phải có khoảng thời gian suy nghĩ và đọc kỹ cảnh báo trước khi hành động.
    5. **Điều kiện mở khóa nút xóa:** Nút *"Xác nhận xóa"* chỉ được kích hoạt (enabled) khi thỏa mãn đồng thời cả 3 điều kiện:
       - Đã hết 5 giây đếm an toàn (`deletionSafetyCountdown === 0`).
       - Email người dùng nhập khớp chính xác với `user.email` (chuẩn hóa không phân biệt hoa thường).
       - Checkbox cam kết rủi ro đã được tích chọn (`deletionRiskConfirmed === true`).

### Chi tiết thay đổi mã nguồn
1. **Giao diện & Logic người dùng (`client/features/public/views/AccountView.jsx`):**
   - Khai báo các state:
     - `deletionVerifyEmail`: Chuỗi email do người dùng nhập để xác nhận.
     - `deletionRiskConfirmed`: Trạng thái boolean của checkbox cam kết.
     - `deletionSafetyCountdown`: Bộ đếm an toàn lùi từ 5 về 0 giây.
     - `deletionCountdownIntervalRef`: Ref lưu trữ ID interval timer để dọn dẹp an toàn khi component unmount hoặc đóng dialog.
   - Thêm hàm `handleOpenDeletion`: Reset toàn bộ các trường nhập và bộ đếm về 5 giây khi người dùng bấm mở dialog.
   - Cập nhật hàm `closeDeletionConfirmation`: Dọn dẹp timer `globalThis.clearInterval` và reset sạch các trường dữ liệu khi đóng dialog hoặc nhấn phím `Escape`.
   - Cập nhật logic `canConfirmDeletion`: Kiểm tra đồng thời cả 3 điều kiện trước khi cho phép bấm nút.
2. **Giao diện & Kiểu dáng CSS (`client/features/public/public-components.css`):**
   - Thêm class `.public-deletion-dialog` mở rộng chiều rộng modal tối đa 520px cho trải nghiệm đọc thoáng đãng.
   - Thêm class `.public-deletion-warning-box` sử dụng token màu `--public-danger` và `--public-danger-soft` với đường viền nổi bật.
   - Thêm class `.public-checkbox-label` với con trỏ pointer và kiểu dáng checkbox màu đỏ nguy hiểm (`accent-color: var(--public-danger)`).
3. **Kiểm thử tự động:**
   - `test/ui/public/public-components.test.js`: Thêm test case `renders account deletion modal with email verification, risk agreement checkbox, and safety countdown` xác minh sự hiện diện của hộp cảnh báo, ô nhập email, checkbox cam kết, và nút xác nhận có nhãn `Xác nhận xóa (5s)` với thuộc tính `disabled`.

---


## 15. Cải Tiến: Đánh Số Thứ Tự Liên Tục (1, 2, 3...) & Hiển Thị Tiêu Đề Bài Feed Cho Citations Trong Hỏi Đáp (Q&A Citation Chips)

### Bối cảnh & Lý do thay đổi
- **Trước khi sửa:**
  - Trong khung trò chuyện Hỏi đáp (`QaView.jsx`), khi AI trả lời kèm nguồn trích dẫn (`citations`), nhãn chip trích dẫn (`citationChipLabel`) ưu tiên hiển thị `sourceName` (ví dụ: *"The Verge"*, *"Google AI Blog"*, *"Hacker News"*) thay vì tiêu đề của bài viết/feed được trích dẫn. Người đọc không biết bài viết đó nói về chủ đề gì nếu chưa bấm mở modal.
  - Cách đánh số chỉ số trích dẫn trước đây dựa trên index của mảng `paragraph.citationIds` trong từng đoạn (`citationIndex + 1`). Nếu câu trả lời có 3 đoạn, mỗi đoạn trích dẫn 1 bài feed khác nhau thì cả 3 chip ở 3 đoạn đều hiển thị số **`[1]`** (`[1] The Verge`, `[1] Google AI Blog`, `[1] Hacker News`), gây nhầm lẫn là chỉ có 1 bài hoặc bị lỗi lặp số.
- **Giải pháp:**
  1. **Đánh số thứ tự liên tục 1, 2, 3... (`citationNumberMap`):**
     - Xây dựng bảng ánh xạ số thứ tự tăng dần duy nhất (`1, 2, 3...`) theo thứ tự các bài feed lần đầu xuất hiện trong các đoạn văn của câu trả lời.
     - Nếu câu trả lời dẫn 3 bài feed thì các con số hiển thị lần lượt là **`[1]`**, **`[2]`**, **`[3]`**. Nếu một bài feed được trích dẫn lại ở các đoạn sau, nó vẫn giữ nguyên số thứ tự ban đầu chuẩn theo quy ước học thuật.
  2. **Hiển thị tiêu đề bài feed làm nội dung chính (`citationChipTitle`):**
     - Chip trích dẫn ưu tiên hiển thị tiêu đề bài feed (`citation.titleVi || citation.titleOriginal || citation.title`).
     - Tên nguồn tin (`citation.sourceName`) được hiển thị phụ trợ phía sau dạng ` · Nguồn` với màu sắc dịu nhẹ.
     - Thiết lập thuộc tính `title` với đầy đủ tiêu đề và nguồn giúp người dùng hover chuột vào là đọc được toàn văn.
     - Cắt gọn tự động (`text-overflow: ellipsis`) nếu tiêu đề bài feed quá dài, bảo đảm không làm vỡ layout chat trên mọi kích thước màn hình.

### Chi tiết thay đổi mã nguồn
1. **Giao diện & Logic (`client/features/public/views/QaView.jsx`):**
   - Thêm hàm `citationChipTitle(citation)`: Lấy `titleVi` hoặc `titleOriginal` của bài feed.
   - Cập nhật hàm `citationChipLabel(citation)`: Kết hợp tiêu đề feed và nguồn `${title} · ${source}`.
   - Cập nhật `CitationDrawer`: Tiêu đề bài viết ưu tiên `titleVi || titleOriginal`.
   - Sửa thứ tự gọi hooks trong `MessageThread`: Đưa `useRef` và `useEffect` lên đầu component trước lệnh điều kiện return để tuân thủ triệt để React Rules of Hooks.
   - Thêm logic `citationNumberMap` trong `MessageThread` để gán số thứ tự liên tục 1, 2, 3... cho các bài feed xuất hiện trong câu trả lời.
2. **Định kiểu giao diện CSS (`client/features/public/public-components.css`):**
   - Cập nhật `.public-citation-chip` dạng inline-flex với hiệu ứng hover mượt mà.
   - Bổ sung các class con: `.public-citation-chip-num` (số thứ tự in đậm màu accent), `.public-citation-chip-title` (tiêu đề bài feed in đậm vừa phải, tự động ellipsis nếu dài quá 320px), `.public-citation-chip-source` (tên nguồn tin màu muted dịu nhẹ).
3. **Kiểm thử tự động:**
   - `test/ui/public/user-flow-fixes.test.js`: Bổ sung test case `renders citation chips with consecutive numbers [1], [2], [3] and displays feed titles instead of only source names` kiểm tra đầy đủ số thứ tự 1, 2, 3, tiêu đề các bài feed và tên nguồn tương ứng.

---

## 16. Cải Tiến: Đồng Bộ Tiêu Đề Tiếng Việt Của Bài Feed (Đã Xử Lý Bởi AI) Cho Chip Trích Dẫn & Drawer Trong Hỏi Đáp

### Bối cảnh & Lý do thay đổi
- **Trước khi sửa:**
  - Khi AI trả lời câu hỏi và đính kèm trích dẫn (citation), các bài viết nguồn dù đã được AI dịch/tóm tắt tiêu đề sang tiếng Việt trên feed (`titleVi` trong MongoDB) nhưng trong chip trích dẫn vẫn hiển thị tiêu đề tiếng Anh gốc (`titleOriginal`, ví dụ: *"Gemini 3.1 Flash TTS: the next generation of expressive AI speech"*).
  - Nguyên nhân: Hợp đồng OpenAPI (`openapi.json`) cho `AnswerCitation` và `HistoricalCitationAvailable` trước đây chỉ định nghĩa trường `titleOriginal` mà không có trường `titleVi`. Backend (`citationEvidenceMetadata` trong `citations.js` và `publicAnswerCitation` trong `chat-repository.js`) chỉ trích xuất `titleOriginal` từ database, làm mất trường `titleVi` khi gửi về client.
  - Phía Client (`QaView.jsx`): Không có cơ chế tra cứu ngược vào danh sách bài viết trên feed (`articles`) theo `articleId` khi citation chưa có sẵn `titleVi`.
- **Giải pháp:**
  1. **Hợp đồng OpenAPI (`docs/contracts/openapi.json`):**
     - Bổ sung trường tùy chọn `titleVi` dạng `["string", "null"]` vào schema `AnswerCitation` và `HistoricalCitationAvailable`.
     - Chạy cập nhật tự động toàn bộ client/contract generation qua `npm run contract:generate`.
  2. **Backend Hydration & Serialization:**
     - `server/domain/qa/citations.js`: Cập nhật `citationEvidenceMetadata` để đọc và trả về `titleVi: article.titleVi` từ evidence database. Cập nhật `serializeHistoricalCitation` để duy trì `titleVi`.
      - `server/repositories/mongo/chat-repository.js`: Cập nhật `publicAnswerCitation` và `historicalCitation` trả về `titleVi` cho client; giữ `historicalCitationDocument` tuân thủ strict schema của MongoDB collection `chatSessions` (không persist `titleVi` để tránh vi phạm validator code 121); khi replay session, `redactHistoricalCitation` sẽ tự động hydrate `titleVi` từ collection `articles`.
  3. **Frontend Integration & Fallback Lookup:**
     - `client/features/public/PublicApp.jsx`: Truyền `articles: feed.articles || []` vào `qa` viewProps.
     - `client/features/public/views/QaView.jsx`: Xây dựng `articlesMap` từ prop `articles`. Cập nhật `citationChipTitle` và `CitationDrawer` ưu tiên:
       `citation.titleVi || articleFromFeed.titleVi || citation.titleOriginal`.
     - Giúp toàn bộ chip trích dẫn hiển thị ngay tiêu đề tiếng Việt đã được AI xử lý trên feed (ví dụ: *"Gemini 3.1 Flash TTS: Thế hệ tiếp theo của giọng nói AI biểu cảm"*), ngay cả đối với các phiên hỏi đáp cũ chưa kịp hydrate `titleVi` từ backend.

### Chi tiết thay đổi mã nguồn
1. **Hợp đồng OpenAPI (`docs/contracts/openapi.json` & `shared/generated/**`):**
   - Thêm thuộc tính `titleVi` vào schemas `AnswerCitation` và `HistoricalCitationAvailable`.
   - Sinh lại API client qua `npm run contract:generate`.
2. **Backend Domain & Repository:**
   - `server/domain/qa/citations.js`: `citationEvidenceMetadata` trả về `titleVi: article.titleVi`.
   - `server/repositories/mongo/chat-repository.js`: Tuân thủ schema lưu trữ của chatSessions (không ghi trường lạ vào database), hydrate động và trả về `titleVi` trong các hàm serialization citation cho client.
3. **Frontend Application:**
   - `client/features/public/PublicApp.jsx`: Truyền prop `articles` cho view Hỏi đáp.
   - `client/features/public/views/QaView.jsx`: Tích hợp `articlesMap` tra cứu tiêu đề tiếng Việt cho chip trích dẫn và drawer.
4. **Kiểm thử tự động:**
   - `test/unit/qa/grounded-answer.test.js`: Thêm unit test kiểm tra `hydrateAnswerCitations` bảo toàn `titleVi` từ bài viết.
   - `test/ui/public/user-flow-fixes.test.js`: Thêm UI test `displays Vietnamese title translated by AI for citation chips and drawer using articles lookup` xác minh hiển thị tiêu đề tiếng Việt trên chip và drawer.

---

## 17. Cải Tiến: Tối Ưu Giao Diện Quản Lý Tài Khoản Cho Người Dùng Đăng Nhập Google OAuth (Ẩn Đổi Mật Khẩu & Xóa Tài Khoản)

### Bối cảnh & Yêu cầu cải tiến
- **Bối cảnh hệ thống:** Dự án hỗ trợ 2 phương thức đăng nhập chính:
  1. **Đăng ký trực tiếp:** Lưu thông tin tài khoản (email và mật khẩu băm) vào cơ sở dữ liệu MongoDB (`passwordEnabled: true`, `hasPassword: true`).
  2. **Đăng nhập bằng Google OAuth:** Sử dụng tài khoản Google thông qua OAuth flow (`passwordEnabled: false`, `hasPassword: false`, `googleSub: '...'`).
- **Vấn đề trước khi sửa:**
  - Trong trang Cài đặt tài khoản (`AccountView.jsx`), hai thẻ **Bảo mật** (*Đổi mật khẩu* / *Đặt mật khẩu*) và **Quản lý dữ liệu** (*Yêu cầu xóa tài khoản*) luôn hiển thị đối với tất cả người dùng, kể cả người dùng đăng nhập thông qua Google OAuth.
  - Người dùng đăng nhập qua Google OAuth sử dụng danh tính Google được xác thực bảo mật từ bên thứ ba, do đó việc hiển thị mục đổi mật khẩu và xóa tài khoản cục bộ là không phù hợp với trải nghiệm người dùng và quy ước quản lý tài khoản liên kết.
- **Yêu cầu:** Khi người dùng đăng nhập bằng Google OAuth và vào mục Cài đặt tài khoản, hai mục **Đổi mật khẩu** và **Xóa tài khoản** hoàn toàn **không xuất hiện** trên giao diện; trong khi người dùng đăng ký trực tiếp bằng email + mật khẩu vẫn giữ nguyên đầy đủ cả hai tính năng này.

### Giải pháp kỹ thuật đã triển khai
1. **Nhận diện chính xác tài khoản Google OAuth:**
   - Dựa vào trường chuẩn hóa trong hợp đồng OpenAPI DTO (`hasPassword: false`) và hỗ trợ mở rộng phòng thủ:
     ```javascript
     const isGoogleUser = user?.hasPassword === false || user?.authProvider === 'google' || Boolean(user?.isGoogle)
     ```
   - Đối với tài khoản đăng ký trực tiếp có mật khẩu: `hasPassword === true` $\rightarrow$ `isGoogleUser === false`.
   - Đối với tài khoản Google OAuth: `hasPassword === false` $\rightarrow$ `isGoogleUser === true`.
2. **Ẩn có điều kiện trên Giao diện (`AccountView.jsx`):**
   - **Thẻ Đổi mật khẩu (`.public-account-security`):** Chỉ render khi `!isGoogleUser`.
   - **Thẻ Quản lý dữ liệu / Xóa tài khoản (`.public-danger-zone`):** Chỉ render khi `!isGoogleUser`.
   - **Modal Dialog:** Các dialog xác nhận xóa (`deletionConfirmationOpen`) và thông báo đổi mật khẩu thành công (`passwordSuccessOpen`) được bảo vệ không render đối với `isGoogleUser`.
   - **Trạng thái khởi tạo:** Các state `showPasswordForm`, `passwordSuccessOpen`, `deletionConfirmationOpen` được gán an toàn `!isGoogleUser && initial...`.
   - **Thẻ Chủ đề quan tâm (`.public-account-card-wide`):** Giữ nguyên định kiểu `grid-column: 1 / -1`, tự động co giãn và hiển thị toàn chiều ngang một cách gọn gàng, tinh tế khi hai thẻ bên dưới ẩn đi.
3. **Kiểm thử tự động:**
   - Cập nhật test case trong `test/ui/public/public-components.test.js` (`omits change-password and delete-account sections in AccountView for Google OAuth accounts`): xác minh cả hai khối HTML của Đổi mật khẩu và Xóa tài khoản đều không xuất hiện trong DOM khi `hasPassword: false`.
   - Giữ nguyên và bảo đảm các test case cho tài khoản có mật khẩu (`hasPassword: true`) tiếp tục pass 100%.

---

## 18. Sửa Lỗi: Tự Động Chuyển Về Form Đăng Nhập (Thay Vì Đăng Ký) Sau Khi Xóa Tài Khoản Hoặc Đăng Xuất

### Bối cảnh & Nguyên nhân lỗi
- **Hiện tượng:** Khi người dùng bấm tạo tài khoản mới (form đăng ký), đăng nhập thành công vào hệ thống, sau đó vào trang Cài đặt tài khoản (`/account`) thực hiện quy trình **"Yêu cầu xóa tài khoản"**, hệ thống thu hồi phiên và chuyển hướng về trang chủ (`LandingPage`). Tuy nhiên, thay vì hiển thị form **Đăng nhập** (`mode = 'login'`), giao diện lại hiển thị form **Đăng ký** (`mode = 'register'`).
- **Nguyên nhân kỹ thuật:**
  1. Trong `client/App.jsx`, state `auth` lưu trữ `{ mode: 'login' | 'register', ... }`. Khi người dùng chuyển sang tab Đăng ký để tạo tài khoản, `auth.mode` được cập nhật thành `'register'`.
  2. Khi người dùng xóa tài khoản (hoặc đăng xuất), hàm `applySession` được kích hoạt để đưa `user` về `null`. Trong `applySession`, lệnh cập nhật `setAuth((current) => ({ ...current, ... }))` sao chép lại toàn bộ `current` mà không reset `mode` về `'login'`. Do đó, `auth.mode` vẫn giữ nguyên giá trị `'register'` từ bước tạo tài khoản trước đó.
  3. Trong component `client/features/public/components/AuthPanel.jsx`, state `mode` bên trong component chỉ được khởi tạo một lần duy nhất qua `useState(() => normalizeAuthMode(initialMode))` mà không có cơ chế đồng bộ lại khi prop `mode` từ parent thay đổi.

### Giải pháp kỹ thuật đã triển khai
1. **Reset `mode: 'login'` tập trung trong `client/App.jsx`:**
   - Cập nhật hàm `applySession`: Bổ sung `mode: 'login'` vào `setAuth` để mọi luồng đăng xuất, thu hồi phiên do xóa tài khoản, phiên hết hạn hoặc đổi mật khẩu thành công đều tự động đưa trạng thái xác thực về form **Đăng nhập**.
   - Cập nhật `guestBrowseNotice`: Đảm bảo khi khách bấm duyệt tin cũng đưa form về trạng thái **Đăng nhập**.
2. **Đồng bộ trạng thái theo mẫu chuẩn React trong `client/features/public/components/AuthPanel.jsx`:**
   - Bổ sung pattern chuẩn *"Adjusting state when a prop changes during render"* (theo khuyến nghị chính thức của React, tránh kích hoạt render trùng lặp hoặc vi phạm `react-hooks/set-state-in-effect`):
     ```javascript
     const [prevMode, setPrevMode] = useState(initialMode)
     const [mode, setMode] = useState(() => normalizeAuthMode(initialMode))
     const [errors, setErrors] = useState({})

     if (prevMode !== initialMode) {
       setPrevMode(initialMode)
       setMode(normalizeAuthMode(initialMode))
       setErrors({})
     }
     ```
   - Khi `initialMode` từ parent thay đổi về `'login'`, `AuthPanel` tự động cập nhật ngay lập tức `mode` về `'login'` và xóa sạch các lỗi validate cũ.
3. **Kiểm thử tự động:**
   - `test/ui/public/public-components.test.js`: Thêm test case `renders login form by default in AuthPanel and provides login action` xác minh form đăng nhập hiển thị mặc định và cung cấp đầy đủ các trường nhập cho login.
   - Toàn bộ test suite client và public components tiếp tục pass 100%.

---

## 19. Sửa Lỗi: Khắc Phục MongoServerError Code 121 (DocumentValidationFailure) Khi Lưu Câu Trả Lời Hỏi Đáp (Q&A)

### Bối cảnh & Nguyên nhân lỗi
- **Hiện tượng:** Sau khi người dùng gửi câu hỏi trong tab Hỏi đáp (Q&A), hệ thống xử lý sinh câu trả lời thành công nhưng tại bước lưu phiên chat (`appendAnswer`), backend báo lỗi:
  ```text
  Q&A infrastructure error { stage: 'appendAnswer', name: 'MongoServerError', code: 121 }
  ```
  Client nhận mã phản hồi HTTP `503 service_unavailable` với thông báo *"Q&A service is temporarily unavailable"*.
- **Nguyên nhân kỹ thuật:**
  1. Trên MongoDB Atlas, collection `chatSessions` có schema validator `CHAT_SESSION_SOURCE_NAME_VALIDATOR` được áp dụng mức `validationLevel: 'strict'`, `validationAction: 'error'`. Nhánh trích dẫn hợp lệ (`available`) được cấu hình nghiêm ngặt với `additionalProperties: false`, chỉ cho phép các trường: `id`, `status`, `articleId`, `sourceId`, `originalUrl`, `titleOriginal`, `publishedAt`, `sourceName`.
  2. Tại commit `be14582c`, hàm `historicalCitationDocument` trong `server/repositories/mongo/chat-repository.js` đã thêm dòng:
     ```javascript
     const titleVi = historicalTitleVi(citation.titleVi)
     ...
     ...(titleVi !== undefined ? { titleVi } : {}),
     ```
     khiến trường `titleVi` bị lưu trực tiếp vào tài liệu MongoDB của `chatSessions`.
  3. Do collection `chatSessions` không cho phép trường lạ ngoài schema (`additionalProperties: false`), MongoDB Atlas lập tức từ chối thao tác cập nhật document với lỗi validation code 121.

### Giải pháp kỹ thuật đã triển khai
1. **Tuân thủ triệt để MongoDB Schema Validator (`server/repositories/mongo/chat-repository.js`):**
   - Loại bỏ việc ghi trường `titleVi` vào `historicalCitationDocument`, đảm bảo document citation lưu trong `chatSessions` hoàn toàn tuân thủ `CHAT_SESSION_SOURCE_NAME_VALIDATOR`.
   - Vẫn đảm bảo tính năng hiển thị `titleVi` tiếng Việt cho người dùng:
     - **Khi AI trả lời trực tiếp:** Đối tượng `publicAnswer` nhận trích dẫn trực tiếp từ `answer.citations` (đã gắn sẵn `titleVi` từ bước tìm kiếm bằng chứng).
     - **Khi đọc lại phiên chat cũ (`getChatSession`):** Hàm `redactHistoricalCitation` tự động truy vấn bài viết từ collection `articles` và hydrate trường `titleVi: article.titleVi` trước khi tuần tự hóa trả về client.
2. **Cập nhật kiểm thử tự động:**
   - `test/unit/chat/citation-redaction.test.js`: Cập nhật test case `persists only the strict available historical union from a public answer citation` xác nhận `historicalCitationDocument` chỉ lưu các trường nghiêm ngặt của schema `available`.
   - Đã chạy kiểm thử trực tiếp trên MongoDB Atlas xác nhận `appendAnswer` lưu thành công mà không gặp lỗi validation 121.

---

## 20. Hướng Dẫn Kiểm Thử Thủ Công Nhanh (Manual Verification)

1. **Kiểm tra độc lập giữa chủ đề AI và Học máy, Software Engineering và JavaScript:**
   - Mở `http://localhost:3000` và chuyển sang tab **Hỏi đáp** (Q&A).
   - Quan sát danh sách chủ đề:
     - Bấm chọn nút hoặc checkbox **AI**: Chỉ duy nhất mục **AI** được chọn (nút sáng, trigger báo `Đã chọn (1) chủ đề`, chip `AI` xuất hiện). Mục **Học máy** hoàn toàn không bị chọn.
     - Bấm mở Popover, tích chọn thêm **Học máy**: Cả **AI** và **Học máy** cùng được chọn (trigger báo `Đã chọn (2) chủ đề`).
     - Bấm bỏ chọn **AI**: Chỉ mục **AI** bị bỏ chọn, mục **Học máy** vẫn giữ nguyên trạng thái đang chọn.
     - Thử tương tự với **Software Engineering** và **JavaScript**: Cả hai hoạt động hoàn toàn độc lập, không bị tự động chọn chéo.
2. **Kiểm tra xóa phiên hỏi đáp:**
   - Mở `http://localhost:3000` và đăng nhập tài khoản.
   - Vào tab **Hỏi đáp** (Q&A), tạo 2-3 phiên hỏi đáp khác nhau.
   - Rê chuột vào từng phiên ở cột bên trái: xuất hiện nút `×`. Bấm vào `×` để xóa riêng phiên đó; danh sách cập nhật ngay lập tức mà các phiên khác không bị mất.
3. **Kiểm tra thanh lọc tìm kiếm & bảng tin (Dropdown nguồn theo 3 Connector):**
   - Vào tab **Tìm kiếm** (Search) hoặc **Bảng tin** (Feed).
   - Quan sát thanh lọc bên dưới ô từ khóa:
     - **Chủ đề:** Dropdown chọn danh mục chuẩn (`Tất cả chủ đề`, `AI`, `AI Agent`, `Robotics`...).
     - **Nguồn:** Bấm mở dropdown nguồn -> Quan sát danh sách được gom thành 3 nhóm rõ ràng: **RSS Feeds**, **arXiv**, **Hacker News** với đầy đủ 10 nguồn.
     - Các ô lọc còn lại gồm: Chế độ (Hybrid/Văn bản), Từ ngày, Đến ngày.
   - Thử chọn một nguồn cụ thể (ví dụ: *Google DeepMind Blog* hoặc *OpenAI News*) và tìm kiếm từ khóa -> Hệ thống lọc chính xác các bài viết thuộc nguồn đó.
4. **Kiểm tra Hỏi đáp trực tiếp từ bài viết & Thẻ ngữ cảnh đầy đủ:**
   - Vào tab **Bảng tin** (Feed), **Tìm kiếm** (Search) hoặc **Bài đã lưu** (Saved).
   - Trên mỗi thẻ bài viết đều xuất hiện nút **"Hỏi đáp"** bên cạnh nút *"Lưu bài"* và *"Đọc chi tiết"*.
   - Bấm nút **"Hỏi đáp"** trên bất kỳ bài viết nào:
     - Trình duyệt chuyển ngay sang tab **Hỏi đáp**.
     - Cột *Phạm vi chủ đề* bên phải hiển thị **Thẻ ngữ cảnh bài viết** đẹp mắt gồm:
       - Badge màu xanh: *"ĐANG HỎI VỀ BÀI VIẾT"* và nút *"Bỏ chọn"*.
       - Tiêu đề bài viết đầy đủ.
       - Tên nguồn tin và ngày xuất bản.
       - Đoạn tóm tắt tiếng Việt của bài viết đó.
     - Nhập câu hỏi và bấm *"Hỏi với nguồn"* -> Câu trả lời tập trung chính xác vào nội dung bài viết đó.
     - Bấm nút **"Bỏ chọn"**: Thẻ ngữ cảnh bài viết biến mất, trở về trạng thái hỏi chung theo các chủ đề toàn hệ thống.
5. **Kiểm tra câu hỏi mẫu và hướng dẫn khi thiếu bằng chứng:**
   - Mở tab **Hỏi đáp** (phiên mới): Màn hình xuất hiện các câu hỏi mẫu gợi ý (ví dụ: *"Google DeepMind có bài viết nào về Gemini 3.1 Flash TTS không?"*).
   - Bấm vào một câu hỏi mẫu: Nội dung tự động điền vào khung câu hỏi và chủ đề `AI` tự động được chọn.
   - Bấm nút **"Hỏi với nguồn"**: AI trả lời thành công kèm citation trích dẫn.
   - Thử hỏi một câu hỏi không có trong tin tức (ví dụ: *"Gemini và Claude có gì mới?"*): Hệ thống hiển thị thông báo từ chối kèm khối hướng dẫn gợi ý hành động rõ ràng.
6. **Kiểm tra tự động đặt tiêu đề phiên hỏi đáp từ câu hỏi đầu tiên:**
   - Vào tab **Hỏi đáp** (Q&A), bấm nút **"Phiên mới"**.
   - Đặt một câu hỏi cụ thể, ví dụ: *"Công nghệ chip bán dẫn 2nm của TSMC có tiến triển gì mới?"* và gửi câu hỏi.
   - Quan sát danh sách phiên bên trái: Tiêu đề phiên được tự động cập nhật thành nội dung câu hỏi rút gọn thay vì chữ *"Phiên hỏi đáp"*.
   - Rê chuột vào tiêu đề phiên: Tooltip trình duyệt hiển thị toàn bộ câu hỏi gốc.
   - Đặt tiếp câu hỏi thứ 2 trong cùng phiên đó: Tiêu đề của phiên vẫn được giữ nguyên vẹn theo câu hỏi đầu tiên.
7. **Kiểm tra Phạm vi chủ đề & Multi-select Dropdown Popover (22 chủ đề):**
   - Vào tab **Hỏi đáp** (Q&A).
   - Quan sát cột bên phải: Tiêu đề đã được đổi thành **"Phạm vi chủ đề"** kèm mô tả *"Giới hạn chủ đề và thời gian bài viết cần hỏi đáp."*.
   - Quan sát nút chọn chủ đề: Mặc định hiển thị `🏷️ Chọn chủ đề bài viết...`.
   - Bấm vào nút trigger: Popover mở ra với ô tìm kiếm và danh sách đầy đủ **22 chủ đề** được phân thành 8 nhóm lĩnh vực công nghệ.
   - Thử gõ từ khóa vào ô tìm kiếm (ví dụ: *"học"* hoặc *"robot"*): Danh sách lọc tức thì chỉ còn các chủ đề khớp từ khóa.
   - Tích chọn 2-3 checkbox (ví dụ: *AI*, *Học sâu & LLM*, *Robotics*):
     - Nút trigger cập nhật thành `🏷️ Đã chọn (3) chủ đề`.
     - Xuất hiện nút *"Bỏ chọn hết"*.
     - Bên dưới xuất hiện 3 chip tương ứng có nút `×` để gỡ nhanh.
   - Bấm ra ngoài khoảng trống hoặc bấm nút *"Xong"*: Popover tự động đóng lại.
   - Bấm nút `×` trên một chip: Chủ đề đó được gỡ bỏ ngay lập tức và số lượng trên nút trigger giảm tương ứng.
8. **Kiểm tra hiệu ứng chờ phản hồi AI mượt mà (Smooth Thinking UX):**
   - Vào tab **Hỏi đáp** (Q&A), nhập một câu hỏi bất kỳ và nhấn Enter (hoặc bấm *"Hỏi với nguồn"*).
   - Quan sát ngay lập tức khi gửi:
     - Ô nhập được làm sạch gọn gàng.
     - Nút gửi chuyển sang trạng thái đang xử lý (`Đang trả lời...`) với icon vòng xoay mượt mà.
     - Trong khung chat: Các tin nhắn cũ (nếu có) **vẫn được giữ nguyên** (không bị giật biến mất). Bong bóng câu hỏi vừa gửi xuất hiện ngay lập tức với hiệu ứng trượt nhẹ.
     - Phía dưới xuất hiện bong bóng suy nghĩ của AI với badge ✨ `Đang truy xuất nguồn và suy nghĩ...`, 3 chấm nhảy nhịp nhàng (`pulsing dots`) và dải sóng ánh sáng shimmer lướt qua êm ái.
     - Khung chat tự động cuộn mượt xuống cuối để người dùng theo dõi.
     - Khi AI hoàn tất trả lời: Bong bóng suy nghĩ chuyển tiếp mượt mà sang câu trả lời kèm các trích dẫn nguồn (citations).
9. **Kiểm tra Chủ đề quan tâm trong Cài đặt tài khoản (Account Preferences):**
   - Đăng nhập tài khoản người dùng và chuyển sang tab **Tài khoản** (`route = 'account'`).
   - Quan sát thẻ **Chủ đề quan tâm**:
     - Xuất hiện thanh công cụ với bộ đếm: `Đã chọn: X/20 chủ đề`.
     - Xuất hiện ô tìm kiếm `Tìm trong 22 chủ đề...`.
     - 22 chủ đề được phân tách gọn gàng thành 8 nhóm lĩnh vực công nghệ, mỗi nhóm có tiêu đề in hoa rõ nét.
     - Các chủ đề cha có nhãn phụ `Chính`.
   - Thử bấm vào một chủ đề con (ví dụ: *Học máy*): Nút chuyển sang trạng thái active màu nổi bật, số lượng trên bộ đếm tăng thêm 1; chủ đề cha *AI* vẫn ở trạng thái chưa chọn độc lập.
   - Thử nhập từ khóa vào ô tìm kiếm (ví dụ: *"an ninh"* hoặc *"cloud"*): Các nhóm và chủ đề lọc tức thì theo từ khóa.
   - Bấm nút **"Lưu chủ đề"**: Hiển thị thông báo thành công `Đã lưu chủ đề quan tâm.` và các chủ đề được lưu bền vững vào database MongoDB.
   - Bấm nút **"Bỏ chọn hết"**: Toàn bộ chủ đề được bỏ chọn nhanh chóng.
10. **Kiểm tra Đóng gói form Đổi mật khẩu, Modal Popup Đếm ngược 5 Giây & Xử lý F5 Reload:**
    - Đăng nhập tài khoản và vào tab **Tài khoản** (`route = 'account'`).
    - Quan sát thẻ **Đổi mật khẩu**:
      - Ban đầu các trường nhập liệu không xuất hiện; chỉ có mô tả và nút **"Đổi mật khẩu"**.
      - Bấm nút **"Đổi mật khẩu"**: Form mở ra với 3 trường nhập (Mật khẩu hiện tại, Mật khẩu mới, Xác nhận mật khẩu) cùng 2 nút **"Xác nhận"** và **"Hủy"**.
      - Bấm nút **"Hủy"**: Form đóng lại và xóa sạch nội dung đã nhập.
      - Bấm lại nút **"Đổi mật khẩu"**, nhập mật khẩu hiện tại và mật khẩu mới hợp lệ (từ 10 ký tự trở lên), bấm **"Xác nhận"**.
    - **Kiểm tra kịch bản 1 - Bộ đếm ngược 5 giây & Tự động đăng xuất:**
      - Khi đổi mật khẩu thành công: Modal Popup nổi bật hiện ra giữa màn hình với phông nền mờ.
      - Tiêu đề: *"Đổi mật khẩu thành công!"*.
      - Nội dung: *"Mật khẩu của bạn đã được cập nhật thành công. Hệ thống sẽ tự động đăng xuất sau 5 giây để bạn đăng nhập lại bằng mật khẩu mới."* với số giây được tô sáng.
      - Nút hành động đếm ngược: `Đăng xuất ngay (5s)` -> `4s` -> `3s` -> `2s` -> `1s` -> `0s`.
      - Khi đếm về 0: Hệ thống tự động kích hoạt đăng xuất và chuyển về trang chủ (`LandingPage`).
      - Bảng đăng nhập xuất hiện thông báo màu xanh: *"Đổi mật khẩu thành công. Vui lòng đăng nhập lại bằng mật khẩu mới."*.
    - **Kiểm tra kịch bản 2 - Bấm "Đăng xuất ngay":**
      - Đổi mật khẩu lại, khi popup hiện ra, bấm ngay nút **"Đăng xuất ngay"** trong lúc đang đếm: Hệ thống lập tức chuyển hướng đăng xuất về trang chủ kèm thông báo thành công mà không phải chờ hết 5 giây.
    - **Kiểm tra kịch bản 3 - F5 / Reload trang trong lúc đang đếm:**
      - Đổi mật khẩu, khi popup hiện ra, nhấn **F5** (hoặc Reload trang trên trình duyệt).
      - Ngay khi trang tải lại, hệ thống lập tức phát hiện cờ chờ đăng xuất, tự động gọi API logout thu hồi phiên và chuyển về trang chủ ở trạng thái đã đăng xuất, hiển thị thông báo thành công màu xanh tại form đăng nhập, không bị kẹt lại phiên đăng nhập cũ.
11. **Kiểm tra Xác thực Tài khoản Đa tầng Trước Khi Xóa Vĩnh Viễn:**
    - Đăng nhập vào tài khoản người dùng và chuyển sang tab **Tài khoản** (`route = 'account'`).
    - Cuộn xuống thẻ **Quản lý dữ liệu** ở cuối trang và bấm nút **"Yêu cầu xóa tài khoản"**.
    - Quan sát Modal Dialog hiện lên giữa màn hình:
      - Hộp cảnh báo màu đỏ viền đậm: *"Cảnh báo quan trọng: Thao tác này sẽ xóa vĩnh viễn tài khoản của bạn..."*.
      - Dòng hướng dẫn: *"Để xác nhận, vui lòng nhập chính xác địa chỉ email của bạn: your-email@example.com"*.
      - Ô nhập email xác nhận: `#account-deletion-email`.
      - Checkbox cam kết rủi ro: *"Tôi hiểu và đồng ý xóa vĩnh viễn tài khoản này cùng toàn bộ dữ liệu liên quan."*.
      - Nút **"Xác nhận xóa (5s)"**: Đang đếm ngược an toàn lùi dần `5s` -> `4s` -> `3s` -> `2s` -> `1s` -> `0s` và **bị khóa (disabled)** hoàn toàn.
    - **Kiểm tra điều kiện khóa an toàn:**
      - Thử bấm nút khi đang đếm: Nút bị vô hiệu hóa, không thể click.
      - Khi đếm về `0s`: Nút đổi nhãn thành **"Xác nhận xóa"** nhưng **vẫn bị disabled**.
      - Thử tích checkbox nhưng chưa gõ email (hoặc gõ sai email): Nút **vẫn bị disabled**.
      - Gõ đúng email nhưng bỏ tích checkbox: Nút **vẫn bị disabled**.
      - Chỉ khi **gõ chính xác email** VÀ **đã tích checkbox** VÀ **đã hết 5 giây an toàn**: Nút **"Xác nhận xóa"** mới sáng lên (enabled) cho phép người dùng click.
    - Bấm nút **"Quay lại"** hoặc nhấn phím **Escape**: Modal đóng lại, toàn bộ timer và dữ liệu nhập trước đó được dọn dẹp sạch sẽ.
12. **Kiểm tra Đánh số thứ tự 1, 2, 3... và Tiêu đề bài Feed cho Citations trong Hỏi đáp:**
    - Mở `http://localhost:3000` và chuyển sang tab **Hỏi đáp** (Q&A).
    - Đặt câu hỏi công nghệ để AI trả lời (hoặc xem một phiên hỏi đáp có trích dẫn từ 2-3 bài viết khác nhau).
    - Quan sát các chip trích dẫn (citation chips) xuất hiện ở cuối các đoạn văn trả lời của AI:
      - Con số ở phía trước được đánh số tuần tự: **`[1]`**, **`[2]`**, **`[3]`** tương ứng với các bài feed khác nhau (không còn bị lặp lại toàn số `[1]`).
      - Nội dung hiển thị chính là **Tiêu đề của bài feed** (rõ ràng, dễ hiểu).
      - Tên nguồn tin hiển thị phụ phía sau (ví dụ: ` · The Verge`, ` · arXiv`).
      - Rê chuột vào chip trích dẫn: Tooltip hiển thị đầy đủ tiêu đề bài feed và nguồn tin.
      - Bấm vào chip trích dẫn: Hộp thoại chi tiết trích dẫn (Citation Drawer) mở ra hiển thị đầy đủ thông tin bài feed gốc cùng nút *"Mở nguồn gốc"*.
13. **Kiểm tra Tiêu đề tiếng Việt đã được AI xử lý cho Citation Chip và Drawer trong Hỏi đáp:**
    - Vào tab **Hỏi đáp** (Q&A), gửi câu hỏi liên quan đến một bài viết đã có bản dịch/tóm tắt tiếng Việt trên Feed (hoặc mở lại một phiên hỏi đáp có trích dẫn bài viết, ví dụ bài viết về *Gemini 3.1 Flash TTS*).
    - Quan sát chip trích dẫn bên dưới đoạn văn trả lời của AI:
      - Tiêu đề hiển thị trên chip là bản tiếng Việt do AI xử lý trên Feed (ví dụ: `[1] Gemini 3.1 Flash TTS: Thế hệ tiếp theo của giọng nói AI biểu cảm · Google DeepMind Blog`) thay vì tiêu đề tiếng Anh gốc (`Gemini 3.1 Flash TTS: the next generation of expressive AI speech`).
      - Rê chuột vào chip trích dẫn: Tooltip hiển thị đầy đủ tiêu đề tiếng Việt và nguồn tin.
      - Bấm vào chip trích dẫn: Hộp thoại chi tiết trích dẫn (Citation Drawer) mở ra hiển thị thẻ `<h3>` tiêu đề tiếng Việt rõ ràng, kèm nút *"Mở nguồn gốc"*.
14. **Kiểm tra Ẩn mục Đổi mật khẩu & Xóa tài khoản khi đăng nhập Google OAuth:**
    - Đăng nhập bằng tài khoản email + mật khẩu thông thường:
      - Vào tab **Tài khoản** (`route = 'account'`).
      - Quan sát giao diện: Xuất hiện đầy đủ cả 3 thẻ: **Chủ đề quan tâm**, **Đổi mật khẩu** (thẻ Bảo mật) và **Quản lý dữ liệu** (thẻ Xóa tài khoản).
    - Đăng nhập bằng tài khoản Google OAuth:
      - Vào tab **Tài khoản** (`route = 'account'`).
      - Quan sát giao diện: Thẻ **Chủ đề quan tâm** mở rộng toàn chiều ngang trang. Thẻ **Đổi mật khẩu** và thẻ **Quản lý dữ liệu (Xóa tài khoản)** hoàn toàn không xuất hiện.
15. **Kiểm tra Chuyển về Form Đăng nhập Sau Khi Xóa Tài Khoản:**
    - Từ trang chủ, bấm chuyển sang form **Tạo tài khoản mới** (`mode = 'register'`).
    - Nhập thông tin đăng ký và tạo tài khoản thành công.
    - Vào tab **Tài khoản** (`route = 'account'`), mở modal và thực hiện **"Yêu cầu xóa tài khoản"**.
    - Sau khi xóa thành công và chuyển hướng về trang chủ:
      - Form xác thực hiển thị tiêu đề **Đăng nhập** (kèm nút bấm *"Đăng nhập"* và ô nhập mật khẩu có `autoComplete="current-password"`), hoàn toàn không bị kẹt lại form Đăng ký.
      - Phía trên form hiển thị thông báo thành công màu xanh: *"Yêu cầu xóa tài khoản đã được chấp nhận. Phiên của bạn đã bị thu hồi."*.
16. **Kiểm tra Hỏi đáp thành công và không bị lỗi MongoServerError 121 khi lưu câu trả lời có trích dẫn:**
    - Mở tab **Hỏi đáp** (Q&A), gửi câu hỏi (ví dụ: *"Google DeepMind đã công bố mô hình speech AI nào dựa trên Gemini?"*).
    - Quan sát câu trả lời hiển thị hoàn chỉnh, đính kèm đầy đủ các chip trích dẫn có tiêu đề tiếng Việt.
    - Kiểm tra terminal chạy server (`npm run dev`): Không xuất hiện lỗi `Q&A infrastructure error { stage: 'appendAnswer', name: 'MongoServerError', code: 121 }`.
    - Nhấn F5 tải lại trang và mở lại phiên hỏi đáp từ cột danh sách bên trái: Phiên chat hiển thị lại mượt mà, chip trích dẫn và drawer vẫn giữ nguyên tiêu đề tiếng Việt đã được hydrate tự động.
