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
- **Giải pháp:** Tự động lấy câu hỏi đầu tiên của người dùng trong phiên, cắt ngắn gọn gàng (tối đa 40 ký tự) để làm tiêu đề hiển thị cho phiên.

### Chi tiết thay đổi mã nguồn
1. **Backend Repository (`server/repositories/mongo/chat-repository.js`):**
   - Trong hàm `appendMessage(sessionId, message, options)`: Khi tin nhắn đầu tiên (`role === 'user'`) được thêm vào phiên chat:
     - Kiểm tra nếu phiên hiện tại chưa có tiêu đề riêng hoặc vẫn mang tiêu đề mặc định `"Phiên hỏi đáp"`.
     - Trích xuất nội dung câu hỏi đầu tiên: lấy tối đa 40 ký tự, nếu câu hỏi dài hơn thì cắt tại ranh giới từ và thêm dấu ba chấm `…`.
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

## 12. Hướng Dẫn Kiểm Thử Thủ Công Nhanh (Manual Verification)

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
