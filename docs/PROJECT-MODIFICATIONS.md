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

## 7. Tự Động Đặt Tên Phiên Hỏi Đáp (Chat Session Auto-Titling)

### 7.1. Bối cảnh & Vấn đề
- Trước đây, khi người dùng mở phiên hỏi đáp mới và đặt câu hỏi, thanh bên (sidebar) danh sách phiên hỏi đáp luôn hiển thị tiêu đề mặc định là **"Phiên hỏi đáp"** cho tất cả các phiên, khiến người dùng khó phân biệt phiên nào thảo luận về chủ đề gì khi xem lại lịch sử.
- Trường `title` trong collection MongoDB `chatSessions` và trong schema OpenAPI đã có sẵn từ trước nhưng luôn được khởi tạo và lưu là `null`.

### 7.2. Giải pháp thực hiện
1. **Hàm trích xuất tiêu đề thông minh (`deriveChatSessionTitle` trong `chat-repository.js`):**
   - Chuẩn hóa khoảng trắng (`\s+` -> ` `).
   - Nếu câu hỏi có độ dài $\le 45$ ký tự: Giữ nguyên câu hỏi làm tên phiên.
   - Nếu câu hỏi dài $> 45$ ký tự: Cắt gọn tại ranh giới từ (word boundary) gần nhất trước ký tự 45, dọn dẹp các dấu câu thừa ở cuối (`?`, `!`, `.`, `,`, `;`, `:`) và thêm ký tự `…`.
   - Với câu hỏi quá dài không có dấu cách: Cắt tại 45 ký tự và thêm `…`.
   - Tương thích an toàn với câu hỏi rỗng hoặc không hợp lệ (trả về fallback `'Phiên hỏi đáp'`).
2. **Lưu trữ tự động khi gửi câu hỏi (`appendAnswer`):**
   - Khi tạo phiên mới hoặc gửi câu hỏi đầu tiên trong phiên (`document.title` đang trống/null), hệ thống tự động gán `title: deriveChatSessionTitle(question)` và lưu vào MongoDB.
   - Các câu hỏi tiếp theo trong cùng phiên sẽ giữ nguyên tiêu đề đã đặt, không bị ghi đè.
3. **Tương thích ngược dữ liệu cũ (`resolveChatSessionTitle`):**
   - Khi trả về danh sách phiên (`listChatSessions`) hoặc chi tiết phiên (`serializeChatSession`):
     - Nếu document đã có `title` đã lưu: Trả về `title`.
     - Nếu phiên cũ trong DB có `title: null`: Tự động trích xuất tiêu đề từ tin nhắn đầu tiên của người dùng (`firstUserMessage.text`).
     - Nếu phiên chưa có tin nhắn nào: Trả về `null` (giao diện tự hiển thị fallback `'Phiên hỏi đáp'`).
4. **Kiểm thử tự động:**
   - Bổ sung 3 test cases chi tiết trong `test/unit/repositories/chat-repository-coverage.test.js`:
     - Test trích xuất và cắt gọn câu hỏi thông minh, dọn dẹp dấu câu.
     - Test ưu tiên tiêu đề lưu sẵn và fallback câu hỏi đầu tiên.
     - Test luồng lưu `title` trong `appendAnswer` và hiển thị qua `listChatSessions`.

---

## 8. Chức Năng Thay Đổi Mật Khẩu Cho Người Dùng (User Change Password Feature)

### 8.1. Bối cảnh & Yêu cầu
- Trước đây, người dùng chỉ có thể đăng nhập bằng email/mật khẩu hoặc tài khoản Google, chưa có tính năng tự đổi mật khẩu khi đã đăng nhập.
- Yêu cầu đặt ra:
  - Cho phép người dùng nhập mật khẩu hiện tại, mật khẩu mới (tối thiểu 10 ký tự, tối đa 128 ký tự) và xác nhận lại mật khẩu mới.
  - Sau khi đổi mật khẩu thành công: vô hiệu hóa toàn bộ phiên đăng nhập hiện tại trên mọi thiết bị (tăng `sessionVersion` $+1$), thu hồi session, xóa cookie phiên đăng nhập và chuyển hướng người dùng ra màn hình đăng nhập kèm thông báo thành công để đăng nhập lại bằng mật khẩu mới.
  - Tài khoản đăng nhập qua bên thứ ba (Google OAuth không có mật khẩu cục bộ): hiển thị thông báo giải thích rõ ràng và ẩn/vô hiệu hóa form đổi mật khẩu.
  - Tuân thủ nguyên tắc Contract-First, bảo mật CSRF, Rate Limiting (10 lần / 15 phút), Audit Logging và Atomic DB Mutation.

### 8.2. Chi tiết thay đổi mã nguồn
1. **Đặc tả OpenAPI & Contract Generator:**
   - `docs/contracts/openapi.json`: Thêm endpoint `POST /api/v1/me/password` với `operationId: changePassword`, body `ChangePasswordRequest` (`currentPassword`, `newPassword`), responses chuẩn RFC 9457 `ProblemDetails` (`200`, `400`, `401`, `403`, `413`, `415`, `422`, `429`, `500`, `503`).
   - `scripts/contracts/openapi-utils.js`: Nâng tổng số operations kiểm tra từ 61 lên 62.
   - `shared/generated/`: Tự động đồng bộ schema và client qua `npm run contract:generate`.
   - `scripts/contracts/auth-account-fixtures.js`: Bổ sung fixture kiểm thử runtime contract cho `changePassword`.
2. **Backend & Bảo mật:**
   - `server/security/rate-limit-scope.js`: Bổ sung scope `'password-change'` với giới hạn 5 requests / 15 phút theo IP (chuẩn hóa đồng bộ tuyệt đối với MongoDB Atlas Collection Validator).
   - `server/audit/writer.js`: Bổ sung audit rule `user_password_changed` (`reasonCode: 'password_changed'`, `changedFields: ['passwordHash', 'sessionVersion']`).
   - `server/repositories/mongo/auth-repository.js`: Thêm hàm `updatePassword(userId, newPasswordHash, options)` thực hiện atomic mutation: cập nhật mật khẩu, tăng `sessionVersion` $+1$, và đánh dấu `revoked: true` toàn bộ phiên cũ.
   - `server/application/auth/service.js`: Triển khai `changePassword({ auth, csrfToken, currentPassword, newPassword, request })`:
     - Kiểm tra CSRF token và rate limit scope `'password-change'`.
     - Kiểm tra trạng thái người dùng (không đổi được nếu bị `suspended` hoặc đã bị xóa).
     - Kiểm tra tài khoản có mật khẩu cục bộ (`passwordHash`), không cho phép đổi mật khẩu trên tài khoản thuần Google.
     - Xác thực mật khẩu cũ bằng `scryptVerifySecret`.
     - Băm mật khẩu mới bằng `scryptDeriveSecret` với cost parameters bảo mật cao.
     - Thực thi cập nhật DB và ghi audit event `user_password_changed`.
   - `server/http/auth-router.js`: Đăng ký validator schema và route handler `POST /api/v1/me/password`, trả về header xóa cookie `serializeClearSessionCookie()`.
   - `server/bootstrap/`: Cập nhật toàn bộ các assertion validator trong `auth.js`, `governance-readiness.js`, `sources.js`, `jobs.js`, `indexing.js` để hỗ trợ tương thích `PASSWORD_CHANGE_RATE_LIMIT_VALIDATOR` và `PASSWORD_CHANGED_AUDIT_VALIDATOR`.
3. **Frontend Integration & Giao diện:**
   - `client/app/integration/session-actions.js`: Thêm hàm `changePassword({ currentPassword, newPassword })`.
   - `client/app/integration/use-public-integration.js`: Cập nhật hook `useAccount`: bổ sung state `changingPassword`, handler `onChangePassword` với cờ `rethrow: true` để ném lỗi chuẩn xác về dialog khi server trả về mã lỗi, ngăn chặn hoàn toàn lỗi nuốt exception báo thành công ảo.
   - `client/features/public/views/AccountView.jsx`:
     - Thêm card **"Bảo mật tài khoản"** (`.public-account-card`) với nút bấm **"Đổi mật khẩu"**.
     - Khi bấm vào nút, hiển thị **Modal Popup Dialog** chuyên nghiệp (`.public-dialog`) với 3 trường nhập: Mật khẩu hiện tại, Mật khẩu mới, Xác nhận mật khẩu mới.
     - Validate trực tiếp tại client: mật khẩu mới $\ge 10$ ký tự, mật khẩu mới không trùng mật khẩu cũ, mật khẩu xác nhận phải khớp chính xác.
     - Hỗ trợ phím Escape và focus trap qua `useDialogFocus`, có nút Hủy đóng modal.
     - Hiển thị thông báo hướng dẫn đối với tài khoản liên kết Google OAuth thay vì nút đổi mật khẩu.
     - Sau khi đổi thành công: tự động đóng modal, xóa session cục bộ, đưa về trang chủ mở modal đăng nhập và hiện thông báo: *"Đã đổi mật khẩu thành công. Vui lòng đăng nhập lại bằng mật khẩu mới."*

### 8.3. Kiểm thử tự động
- `test/security/auth-service.test.js`: 18 tests passed (kiểm tra toàn bộ luồng đổi mật khẩu: sai mật khẩu cũ, trùng mật khẩu cũ, tài khoản không có mật khẩu, tăng sessionVersion).
- `test/security/auth-http.test.js`: 6 tests passed (kiểm tra HTTP endpoint, CSRF, response headers và status codes).
- `test/unit/repositories/auth-repository.test.js`: 10 tests passed (kiểm tra atomic DB mutation).
- `test/client/session-actions.test.js`: 12 tests passed (kiểm tra client API call, hủy phiên khi thành công và không hủy phiên khi request bị reject).
- `test/ui/public/public-coverage.test.js`: 5 tests passed (kiểm tra UI component render và submit form cả trạng thái đóng và mở dialog).
- `npm run contract:validate`, `npm run contract:generate`, `npm run contract:test`: Pass 100%.

---

## 9. Hướng Dẫn Kiểm Thử Thủ Công Nhanh (Manual Verification)

1. **Kiểm tra chức năng Đổi mật khẩu (dạng Button & Popup Modal):**
   - Mở `http://localhost:3000` và đăng nhập bằng tài khoản email/mật khẩu.
   - Nhấp vào avatar / tên người dùng ở góc trên bên phải để vào trang **Tài khoản** (`/account`).
   - Cuộn xuống phần thẻ **"Bảo mật tài khoản"**:
     - Thấy nút bấm **"Đổi mật khẩu"**.
     - Bấm vào nút **"Đổi mật khẩu"**: Một cửa sổ pop-up (Modal Dialog) nổi lên với nền mờ làm mờ hậu cảnh.
     - Thử bấm nút **"Hủy"** hoặc phím `Esc`: Popup đóng lại.
     - Bấm mở lại popup:
       - Thử nhập mật khẩu hiện tại sai -> Thông báo lỗi: *"Mật khẩu hiện tại không chính xác"*.
       - Thử nhập mật khẩu mới dưới 10 ký tự -> Thông báo lỗi client: *"Mật khẩu mới phải có ít nhất 10 ký tự"*.
       - Thử nhập mật khẩu mới trùng mật khẩu hiện tại -> Thông báo lỗi: *"Mật khẩu mới không được trùng với mật khẩu hiện tại"*.
       - Thử nhập mật khẩu xác nhận không khớp -> Thông báo lỗi: *"Mật khẩu xác nhận không khớp"*.
       - Nhập đầy đủ thông tin hợp lệ và bấm **"Cập nhật mật khẩu"**:
         - Hệ thống gọi API, tăng `sessionVersion` $+1$, thu hồi phiên và xóa session cookie.
         - Trình duyệt tự động chuyển về trang chủ, mở modal Đăng nhập kèm thông báo xanh: *"Đã đổi mật khẩu thành công. Vui lòng đăng nhập lại bằng mật khẩu mới."*
         - Đăng nhập lại bằng mật khẩu cũ: Thất bại.
         - Đăng nhập lại bằng mật khẩu mới: Thành công!
   - (Nếu đăng nhập bằng tài khoản Google): Phần thẻ Bảo mật tài khoản hiển thị thông báo: *"Tài khoản này được đăng nhập bằng Google nên không sử dụng mật khẩu riêng."* và không hiển thị nút đổi mật khẩu.
2. **Kiểm tra tự động đặt tên phiên hỏi đáp:**
   - Mở `http://localhost:3000` và đăng nhập tài khoản.
   - Vào tab **Hỏi đáp** (Q&A), tạo một phiên hỏi đáp mới.
   - Nhập một câu hỏi bất kỳ, ví dụ: *"Xu hướng phát triển của AI Agent trong năm 2026 là gì?"*.
   - Bấm **Hỏi với nguồn**: Sau khi câu trả lời hoàn tất, quan sát cột danh sách phiên bên trái:
     - Tên phiên lập tức cập nhật thành: **"Xu hướng phát triển của AI Agent trong năm…"** (cắt gọn đẹp mắt, không còn hiển thị chữ *"Phiên hỏi đáp"* chung chung).
   - Hỏi thêm một câu hỏi thứ 2 trong phiên đó: Tên phiên vẫn được giữ nguyên ổn định theo chủ đề câu hỏi đầu tiên.
3. **Kiểm tra xóa phiên hỏi đáp:**
   - Vào tab **Hỏi đáp** (Q&A), tạo 2-3 phiên hỏi đáp khác nhau.
   - Rê chuột vào từng phiên ở cột bên trái: xuất hiện nút `×`. Bấm vào `×` để xóa riêng phiên đó; danh sách cập nhật ngay lập tức mà các phiên khác không bị mất.
4. **Kiểm tra thanh lọc tìm kiếm mới:**
   - Vào tab **Tìm kiếm** (Search).
   - Quan sát thanh lọc bên dưới ô từ khóa:
     - **Chủ đề:** Dropdown chọn danh mục chuẩn (`Tất cả chủ đề`, `AI`, `AI Agent`, `Robotics`...).
     - **Nguồn:** Dropdown chọn tên nguồn tin đọc được (`Tất cả nguồn`, `The Verge`, `Google AI Blog`, `arXiv`...).
     - Các ô lọc còn lại gồm: Chế độ (Hybrid/Văn bản), Từ ngày, Đến ngày.
   - Thử chọn một nguồn cụ thể (ví dụ: Google AI Blog) và tìm kiếm từ khóa -> Hệ thống lọc chính xác các bài viết thuộc nguồn đó.
5. **Kiểm tra Hỏi đáp trực tiếp từ bài viết & Thẻ ngữ cảnh đầy đủ:**
   - Vào tab **Bảng tin** (Feed), **Tìm kiếm** (Search) hoặc **Bài đã lưu** (Saved).
   - Trên mỗi thẻ bài viết đều xuất hiện nút **"Hỏi đáp"** bên cạnh nút *"Lưu bài"* và *"Đọc chi tiết"*.
   - Bấm nút **"Hỏi đáp"** trên bất kỳ bài viết nào:
     - Trình duyệt chuyển ngay sang tab **Hỏi đáp**.
     - Cột *Phạm vi nguồn* bên phải hiển thị **Thẻ ngữ cảnh bài viết** đẹp mắt gồm:
       - Badge màu xanh: *"ĐANG HỎI VỀ BÀI VIẾT"* và nút *"Bỏ chọn"*.
       - Tiêu đề bài viết đầy đủ.
       - Tên nguồn tin và ngày xuất bản.
       - Đoạn tóm tắt tiếng Việt của bài viết đó.
     - Nhập câu hỏi và bấm *"Hỏi với nguồn"* -> Câu trả lời tập trung chính xác vào nội dung bài viết đó.
     - Bấm nút **"Bỏ chọn"**: Thẻ ngữ cảnh bài viết biến mất, trở về trạng thái hỏi chung theo các chủ đề toàn hệ thống.
6. **Kiểm tra câu hỏi mẫu và hướng dẫn khi thiếu bằng chứng:**
   - Mở tab **Hỏi đáp** (phiên mới): Màn hình xuất hiện các câu hỏi mẫu gợi ý (ví dụ: *"Google DeepMind có bài viết nào về Gemini 3.1 Flash TTS không?"*).
   - Bấm vào một câu hỏi mẫu: Nội dung tự động điền vào khung câu hỏi và chủ đề `AI` tự động được chọn.
   - Bấm nút **"Hỏi với nguồn"**: AI trả lời thành công kèm citation trích dẫn.
   - Thử hỏi một câu hỏi không có trong tin tức (ví dụ: *"Gemini và Claude có gì mới?"*): Hệ thống hiển thị thông báo từ chối kèm khối hướng dẫn gợi ý hành động rõ ràng.
