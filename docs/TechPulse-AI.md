# TechPulse AI

> Trạng thái: Phạm vi MVP đã chốt / tài liệu sống
> Cập nhật lần đầu: 07/08/2026
> Cập nhật gần nhất: 09/08/2026
> Mục đích: Lưu định hướng sản phẩm, phạm vi MVP, hướng phát triển và các ràng buộc quan trọng trước khi viết PRD hoặc thiết kế kỹ thuật chi tiết.
> Bộ tài liệu triển khai: [README.md](./README.md)

## 1. Ý tưởng gốc

TechPulse AI là một web app tổng hợp tin tức và nội dung chuyên ngành về:

- Computer Science;
- Artificial Intelligence;
- AI Agent;
- Robotics;
- Software Engineering;
- các công nghệ mới có ảnh hưởng trực tiếp đến lập trình viên và người làm trong ngành IT.

Sản phẩm hướng đến sinh viên công nghệ, lập trình viên, kỹ sư phần mềm và những người làm trong ngành cần theo dõi nhiều nguồn tin nhưng không có đủ thời gian đọc từng bài riêng lẻ.

TechPulse AI không đặt mục tiêu sao chép hoặc thay thế các trang báo gốc. Giá trị chính của sản phẩm là:

1. Thu thập metadata từ một danh sách nguồn đã được kiểm tra.
2. Chuẩn hóa, phân loại và loại bỏ tin trùng lặp.
3. Dùng AI để tạo bản tóm tắt ngắn bằng cách diễn đạt mới.
4. Cho phép người dùng hỏi đáp và tổng hợp thông tin từ nhiều nguồn.
5. Đưa ra citation rõ ràng để người dùng kiểm chứng và mở bài viết gốc.

### Đề xuất giá trị cốt lõi

> Giúp người làm công nghệ nắm bắt nhanh một chủ đề, biết thông tin đến từ đâu và có thể kiểm chứng từng kết luận quan trọng.

### Điểm khác biệt dự kiến

- Không chỉ hiển thị một danh sách link như RSS reader thông thường.
- Không chỉ tóm tắt từng bài độc lập.
- AI phải trả lời dựa trên dữ liệu được truy xuất, kèm nguồn và thời gian xuất bản.
- Phân biệt rõ dữ kiện từ nguồn, phát biểu được trích dẫn và suy luận do AI tạo ra.
- Từ chối trả lời khi không có đủ bằng chứng thay vì dùng kiến thức nền của mô hình để đoán.

## 2. Đối tượng và vấn đề cần giải quyết

### Người dùng mục tiêu ban đầu

- Sinh viên ngành Công nghệ thông tin muốn cập nhật kiến thức mới.
- Developer và software engineer muốn theo dõi AI, Agent và công cụ phát triển.
- Người làm trong ngành cần bản tổng hợp nhanh nhưng vẫn muốn kiểm tra nguồn gốc thông tin.

### Vấn đề hiện tại

- Tin công nghệ phân tán trên nhiều blog, trang báo, diễn đàn và nguồn nghiên cứu.
- Một sự kiện thường được nhiều nguồn đăng lại, gây trùng lặp.
- Người đọc mất nhiều thời gian để xác định bài nào đáng đọc.
- Chatbot thông thường có thể trả lời thiếu nguồn, dùng kiến thức cũ hoặc tạo thông tin không có căn cứ.
- Bản tóm tắt quá đầy đủ có thể làm mất động lực truy cập bài viết gốc và tạo rủi ro bản quyền.

## 3. Nguyên tắc sản phẩm

1. **Source-first:** mọi tin và câu trả lời quan trọng phải truy ngược được về nguồn.
2. **Không thay thế bài gốc:** bản tóm tắt chỉ giúp quyết định có nên đọc tiếp; luôn hiển thị liên kết đến bài gốc.
3. **AI có giới hạn:** hệ thống phải nói “chưa đủ bằng chứng” khi dữ liệu không đủ.
4. **Nguồn theo allowlist:** MVP chỉ thu thập từ nguồn đã được kiểm tra API, RSS, giấy phép và điều khoản sử dụng.
5. **Không vượt biện pháp bảo vệ:** không vượt paywall, CAPTCHA, đăng nhập hoặc biện pháp kỹ thuật của website.
6. **Nội dung bên ngoài là dữ liệu không đáng tin cậy:** AI không được thực thi chỉ dẫn hoặc prompt xuất hiện bên trong bài viết.
7. **Phạm vi nhỏ nhưng hoàn chỉnh:** ưu tiên một luồng end-to-end hoạt động tốt hơn việc thu thập quá nhiều nguồn.
8. **Quyền sử dụng được thực thi bằng code:** phạm vi gửi tới LLM/embedding phải lấy từ Source Registry, không dựa vào suy đoán tại runtime.
9. **Tiếng Việt trước:** UI, summary và AI Q&A của MVP dùng tiếng Việt; nguồn gốc và citation luôn được giữ nguyên.
10. **Hiển thị media khác với xử lý media:** link nguồn, preview ảnh và input AI là ba quyền khác nhau; một quyền không tự suy ra hai quyền còn lại.

## 4. Luồng sử dụng chính của MVP

1. Người dùng đăng nhập và chọn các chủ đề quan tâm.
2. Người dùng xem feed tin công nghệ đã được phân loại và loại bỏ bản ghi trùng.
3. Người dùng mở một tin để xem metadata, bản tóm tắt AI và link bài gốc.
4. Người dùng đặt câu hỏi về một bài hoặc một chủ đề trong khoảng thời gian cụ thể.
5. Hệ thống truy xuất các tài liệu phù hợp và tạo câu trả lời có citation.
6. Nếu bằng chứng không đủ hoặc các nguồn mâu thuẫn, hệ thống phải thông báo rõ.
7. Người dùng mở nguồn gốc để đọc toàn bộ nội dung và tự kiểm chứng.

## 5. Feature tối thiểu cho MVP

### 5.1. Tài khoản và sở thích người dùng

- Đăng ký, đăng nhập và đăng xuất.
- Lưu mật khẩu bằng hàm băm an toàn; không lưu mật khẩu dạng rõ.
- MVP có hai role dành cho con người: `user` và `admin`.
- Tài khoản đăng ký công khai luôn có role `user`; client không được gửi hoặc tự thay đổi role.
- Chọn hoặc theo dõi các chủ đề như AI, AI Agent, Robotics và Software Engineering.
- Lưu bài viết để đọc sau.

### 5.2. Source Registry

Trang quản trị nguồn là một phần bắt buộc của MVP, không phải tính năng phụ.

Mỗi nguồn cần lưu tối thiểu:

- tên nguồn, `publisherName`, domain và chủ thể quyền nếu xác định được;
- URL API, RSS/Atom hoặc category/query tương ứng;
- `accessMethod` và loại connector;
- cấp độ thẩm quyền của nguồn: `primary`, `editorial` hoặc `community-signal`;
- trạng thái vận hành `draft`, `testing`, `active`, `paused` hoặc `archived`;
- `termsUrl`, `licenseUrl`, loại giấy phép và ghi chú về attribution;
- `licenseStatus`: `permitted`, `metadata-only`, `review-needed` hoặc `blocked`;
- `llmInputScope`: `metadata`, `excerpt`, `fulltext-temporary` hoặc `none`;
- `storageScope`: phạm vi metadata, summary và dữ liệu dẫn xuất được phép lưu;
- `mediaPolicy`: `imageMode` (`none` hoặc `remote-preview`), `videoMode` (`none` hoặc `link-only`), `allowedHosts`, yêu cầu attribution và ghi chú bằng chứng riêng cho media;
- `attributionRequired`, `evidenceNote`, `reviewedAt` và `reviewedBy`.

Các khái niệm phải được phân biệt rõ:

- **Publisher** là tổ chức xuất bản hoặc vận hành nguồn; publisher không tự động đồng nghĩa với chủ sở hữu mọi thành phần trong bài.
- **License** hoặc văn bản cho phép mới xác định phạm vi tái sử dụng; website công khai hoặc đọc miễn phí không mặc nhiên cấp license.
- `robots.txt` chỉ là tín hiệu về truy cập tự động, không phải giấy phép bản quyền.
- API/RSS cho phép truy cập dữ liệu không đồng nghĩa với quyền lưu, dịch, gửi toàn văn tới AI hoặc tái xuất bản.

Quy trình duyệt nguồn của MVP:

```text
draft → technical-check → review-needed
review-needed → active + permitted
review-needed → active + metadata-only
review-needed → blocked

active ↔ paused → archived
```

- Hệ thống tự kiểm tra URL, protocol, redirect, content type, khả năng parse và lỗi kết nối.
- Admin kiểm tra Terms of Use, API/RSS terms, copyright/license trên bài và kênh licensing của publisher.
- AI có thể hỗ trợ trích xuất hoặc giải thích điều khoản nhưng không được tự phê duyệt nguồn.
- Nếu không tìm thấy quyền xử lý rõ ràng, nguồn mặc định là `metadata-only`, không phải `permitted`.
- Hệ thống không được tạo production ingestion job cho nguồn `blocked` hoặc `review-needed`; technical check có thể lấy mẫu tối thiểu cần thiết. Nguồn `metadata-only` chỉ được xử lý trong phạm vi đã cấu hình.

### 5.3. Pipeline thu thập dữ liệu

- Pipeline được thiết kế theo kiến trúc connector; số lượng nguồn không bị hard-code trong ứng dụng.
- MVP chỉ triển khai ba nhóm connector:
  - **RSS/Atom Connector:** nhận dữ liệu từ nhiều feed báo chí, blog công nghệ, research lab và website tổ chức đã được duyệt trong Source Registry;
  - **arXiv Connector:** nhận metadata và abstract theo category hoặc truy vấn được cấu hình; chỉ xử lý full text khi giấy phép của paper cho phép;
  - **Hacker News Connector:** nhận các item từ API chính thức như `topstories`, `newstories` và `beststories` để phát hiện xu hướng cộng đồng.
- Phạm vi demo dự kiến gồm 8–10 RSS/Atom feed, 3 arXiv category/query và 3 luồng Hacker News kể trên.
- Hacker News được xem là nguồn `community-signal`: vẫn xuất hiện ở feed/search discovery nhưng bị loại khỏi AI Q&A evidence/citation trong MVP. Bài liên kết từ HN chỉ trở thành evidence khi được onboard thành source primary/editorial độc lập.
- Chỉ dùng API chính thức, RSS/Atom hoặc phương thức truy cập được nguồn cho phép.
- Chạy một lần mỗi ngày bằng Vercel Cron và cho phép admin yêu cầu chạy thủ công.
- Mỗi lần chạy xử lý một batch có giới hạn; trạng thái và lock của job phải lưu trong MongoDB.
- Chuẩn hóa dữ liệu về một schema chung.
- Lưu log cho mỗi lần ingest: nguồn, thời gian, số bản ghi thành công, số bản ghi lỗi và lý do lỗi.
- Job phải idempotent vì cron có thể được gọi lặp; retry do ứng dụng quản lý vì Vercel không tự retry cron thất bại.
- Có retry giới hạn, rate limiting, distributed lock và cơ chế tắt nhanh một nguồn gặp vấn đề.

#### 5.3.1. Chính sách xử lý nội dung

| `llmInputScope` | Dữ liệu được gửi tới AI | Quy tắc |
|---|---|---|
| `metadata` | title, author, date, topic và URL | Không fetch toàn văn |
| `excerpt` | metadata và excerpt chính thức | Không tự mở rộng sang nội dung trang |
| `fulltext-temporary` | phần main content đã làm sạch và chia chunk | Chỉ dùng khi quyền xử lý rõ ràng; không lưu toàn văn |
| `none` | Không có | Không gọi LLM/embedding với dữ liệu nguồn |

- Không gửi raw HTML, menu, quảng cáo, comment hoặc phần không liên quan tới LLM.
- Với `fulltext-temporary`, backend chỉ giữ nội dung trong thời gian xử lý, loại bỏ markup, chia chunk cần thiết rồi giải phóng sau khi tạo summary.
- Nội dung đã làm sạch vẫn là dữ liệu không đáng tin cậy và không được phép thay đổi system instruction hoặc kích hoạt tool.
- Không vượt paywall, đăng nhập, CAPTCHA hoặc biện pháp bảo vệ để lấy full text.
- Dữ liệu được phép lưu lâu dài trong MVP là metadata, summary ngắn, citation, hash và embedding tạo từ phạm vi hợp lệ.
- Binary ảnh, video, audio và logo luôn nằm ngoài persistence và AI pipeline MVP; MongoDB không lưu file, base64, GridFS hoặc bản cache media nguồn.
- Connector chỉ có thể giữ metadata/URL media. Ảnh chỉ được remote-preview nếu current `mediaPolicy.imageMode=remote-preview` và hostname thuộc `allowedHosts`; video quan trọng chỉ được hiển thị dưới dạng link về nguồn khi `videoMode=link-only`.
- Không tự dùng mọi `og:image`, không tạo backend proxy để né hotlink và không suy diễn “công khai” thành “được phép sao chép”. Khi media không được phép hoặc lỗi, UI dùng visual fallback do TechPulse sở hữu.
- Media MVP luôn có trạng thái `not-analyzed`; summary, embedding và Q&A không được dùng chi tiết chỉ xuất hiện trong ảnh/video.

Metadata tối thiểu của một bài:

```text
titleOriginal
titleVi
originalUrl
canonicalUrl
sourceId
connectorType
externalId
sourceType
authorityTier
author
publishedAt
retrievedAt
sourceLanguage
topics
excerptOriginal
summaryVi
summaryStatus
summaryBasis
contentScope
licenseStatus
llmInputScope
embeddingStatus
embeddingModel
embeddingDimensions
embeddingInputHash
embeddingVersion
embeddedAt
leadMedia.type
leadMedia.displayMode
leadMedia.url
leadMedia.sourcePageUrl
leadMedia.altText
leadMedia.credit
leadMedia.mediaEvidenceStatus
```

Không lưu toàn bộ nội dung bài viết trong MVP, kể cả khi được dùng tạm thời để tạo summary.

### 5.4. Chuẩn hóa, phân loại và chống trùng

- Chuẩn hóa canonical URL và thời gian xuất bản.
- Phát hiện bản ghi trùng bằng canonical URL, external ID, normalized title và hash của phần nội dung được phép xử lý.
- Có thể dùng độ tương đồng embedding để hỗ trợ phát hiện gần trùng, nhưng không tự hợp nhất nếu điểm số chưa đủ chắc chắn.
- Phân loại tối thiểu theo các chủ đề đã xác định.
- Cho phép admin sửa chủ đề hoặc hợp nhất bản ghi bị trùng sai.

### 5.5. News Feed và tìm kiếm

- Feed mới nhất theo chủ đề.
- Lọc theo nguồn, chủ đề và khoảng thời gian.
- Tìm kiếm từ khóa trên `titleOriginal`, `titleVi`, `summaryVi`, `topics` và trường `searchTextNormalized` đã viết thường/bỏ dấu.
- Dùng MongoDB text index với `default_language: "none"` cùng index thông thường cho status, source, topic và thời gian.
- Semantic retrieval dùng embedding của `titleOriginal + titleVi + summaryVi + topics`; với quy mô vài trăm bài, backend tính cosine similarity trong Node.js.
- Nếu embedding provider lỗi hoặc bài chưa có embedding, hệ thống phải fallback về text search thay vì làm hỏng feed hoặc AI Q&A.
- Phân trang hoặc infinite scroll có kiểm soát.
- Mỗi card phải hiển thị tên nguồn, tác giả nếu có, ngày xuất bản và liên kết bài gốc.
- Card có thể hiển thị ảnh đại diện đã qua media policy; nếu không có/quá trình tải lỗi thì dùng visual fallback của TechPulse, không proxy hoặc lưu bản sao nguồn.

### 5.6. Trang chi tiết tin

- Tiêu đề gốc, tiêu đề tiếng Việt nếu được tạo, nguồn, tác giả, ngôn ngữ nguồn, ngày xuất bản và ngày hệ thống thu thập.
- Bản tóm tắt AI ngắn bằng tiếng Việt, dùng cách diễn đạt mới.
- Hiển thị summary được tạo từ `metadata`, `excerpt` hay `fulltext-temporary` để người dùng hiểu giới hạn bằng chứng.
- Chủ đề được hệ thống phân loại.
- Nút **Đọc bài gốc** được đặt nổi bật.
- Thông báo rằng nội dung được AI dịch/tổng hợp và có thể cần kiểm chứng.
- Nếu media policy cho phép, hiển thị ảnh remote-preview cùng alt/credit; nếu video là phần quan trọng, hiển thị link tới trang nguồn và nhãn **AI chưa phân tích video này**.
- Không hiển thị lại toàn bộ bài viết, không rehost media và không hiển thị media khi nguồn không cho phép.

### 5.7. AI Q&A có citation

- Người dùng có thể hỏi về một bài, một chủ đề hoặc một khoảng thời gian.
- Backend truy xuất dữ liệu phù hợp trước khi gọi mô hình AI.
- Câu trả lời chỉ được sử dụng phần dữ liệu có `licenseStatus` phù hợp.
- Trang chi tiết và summary dùng citation cấp bài.
- AI Q&A gắn citation sau từng đoạn hoặc nhóm phát biểu; citation cấp từng claim được để lại cho hậu MVP.
- Mỗi citation hiển thị tối thiểu tên nguồn, title gốc, tác giả nếu có, ngôn ngữ nguồn, ngày xuất bản và original URL.
- Nếu nhiều nguồn mâu thuẫn, phải trình bày sự khác biệt thay vì tự chọn một nguồn là đúng.
- Nếu không đủ dữ liệu, trả lời rõ rằng hệ thống chưa có đủ bằng chứng.
- Không cho phép mô hình làm theo chỉ dẫn nằm trong nội dung bài viết được ingest.
- Không dùng nội dung chỉ có trong ảnh/video `not-analyzed` để tạo claim hoặc citation.

### 5.8. Trang quản trị tối thiểu

Trang quản trị là bề mặt vận hành nội bộ của TechPulse AI. Phần lớn pipeline vẫn chạy tự động; admin dùng dashboard để cấu hình, giám sát và xử lý ngoại lệ. Bản ghi hợp lệ được pipeline tự động xuất bản, vì vậy admin không phải duyệt thủ công từng bài trong luồng bình thường.

#### 5.8.1. Actor và ranh giới quyền

| Năng lực | `user` | `admin` | `system-worker` |
|---|---:|---:|---:|
| Xem feed, tìm kiếm, lưu bài và hỏi AI | Có | Có | Không |
| Quản lý nguồn và chính sách sử dụng | Không | Có | Chỉ đọc cấu hình đã duyệt |
| Yêu cầu chạy hoặc retry ingestion/indexing | Không | Có | Không |
| Thực thi ingestion, summary, indexing và account-deletion job | Không | Không | Có |
| Ẩn bài, sửa topic, hợp nhất bản trùng | Không | Có | Không |
| Xử lý yêu cầu gỡ nội dung và khóa user | Không | Có | Không |
| Ghi audit/operational log | Không | Tạo qua thao tác | Tạo qua quá trình chạy job |

- `system-worker` là danh tính nội bộ của backend, không phải tài khoản có thể đăng nhập vào giao diện. Trong MVP, actor này là Vercel Function được gọi bởi cron hoặc trigger quản trị.
- Frontend không fetch nguồn bên ngoài. Admin chỉ yêu cầu chạy job; function phía server xác thực yêu cầu, lấy distributed lock và xử lý một batch có giới hạn.
- Worker không sử dụng session hoặc mật khẩu của admin.

#### 5.8.2. Đăng nhập và bảo vệ trang admin

- Admin đăng nhập bằng tài khoản có role `admin` thông qua cùng authentication backend với user.
- Có thể dùng giao diện riêng `/admin/login` và `/admin`, nhưng URL riêng không được xem là biện pháp bảo mật.
- Phương án mặc định cho MVP là server-side session lưu trong MongoDB, cookie host-only `__Host-techpulse_session; Secure; HttpOnly; Path=/; SameSite=Lax`, không `Domain` và không lưu auth token trong `localStorage`/memory của Vercel Function. Browser API same-origin only, mutation yêu cầu exact Origin + CSRF, auth response `no-store, private`.
- Mọi endpoint `/api/admin/*` phải kiểm tra authentication và role tại backend. Chỉ ẩn nút hoặc route ở React là không đủ.
- Chưa đăng nhập trả về `401`; đã đăng nhập nhưng không phải admin trả về `403`.
- Tài khoản admin đầu tiên được tạo bằng seed script hoặc thao tác triển khai có kiểm soát; không có API đăng ký admin công khai và không có giao diện đổi role trong MVP.
- Login và các thao tác tốn tài nguyên phải có input validation, rate limiting và bảo vệ CSRF phù hợp với cơ chế session.
- Sau reload, browser gọi `/api/v1/me` để nhận lại CSRF token gắn với session vào memory; không lưu token ở `localStorage`.

#### 5.8.3. Quản lý nguồn

Admin có thể:

- tạo và cập nhật source definition cho RSS/Atom, arXiv hoặc Hacker News;
- kiểm tra kết nối trước khi bật nguồn;
- cấu hình connector, URL/feed, category/query, lịch chạy và cấp độ thẩm quyền;
- ghi nhận publisher, `termsUrl`, `licenseUrl`, `licenseStatus`, bằng chứng kiểm tra, attribution, `llmInputScope` và `storageScope`;
- cấu hình media policy độc lập: cho phép/tắt ảnh preview, video link-only, hostname media được duyệt, attribution và evidence note;
- bật, tạm dừng, chặn hoặc lưu trữ một nguồn;
- xem lần ingest thành công gần nhất và lỗi gần nhất của nguồn.

Ràng buộc:

- nguồn `review-needed` hoặc `blocked` không được tạo production ingestion job mới; thao tác test connection chỉ lấy mẫu tối thiểu;
- `metadata-only` chỉ được xử lý trong phạm vi metadata được phép;
- `licenseStatus`, `llmInputScope`, `storageScope` và media policy phải qua compatibility matrix; payload đúng cú pháp nhưng nâng scope vẫn bị từ chối;
- không tìm thấy quyền rõ ràng thì admin phải chọn `metadata-only`, không tự suy diễn thành `permitted`;
- `robots.txt` được xem như tín hiệu kỹ thuật, không được ghi nhận như bằng chứng license;
- URL do admin nhập chỉ chấp nhận canonical HTTPS không credential. Backend validate toàn bộ A/AAAA, chặn mixed public/private/link-local/IPv4-mapped private, pin actual connection vào IP đã kiểm tra và tự revalidate/pin từng redirect để chặn DNS rebinding/SSRF;
- hostname media phải là canonical lowercase public DNS host đã review; cấm wildcard, IP literal, localhost/single-label/private host. Server DNS pinning không bảo vệ direct browser preview, nên client không gửi credential/referrer, dùng CSP exact-host và fallback;
- credential của connector, nếu có, được cấu hình bằng biến môi trường hoặc hệ thống secret khi triển khai; admin không nhập hoặc đọc secret trực tiếp trên dashboard;
- tắt nguồn chỉ dừng lần ingest tiếp theo, không tự động xóa dữ liệu cũ. Việc giữ, ẩn hoặc xóa dữ liệu đã có phải là quyết định riêng và được audit.
- khi Terms thay đổi, thao tác re-review phải atomically pause source, đặt `review-needed`, tăng policy version và ghi durable pending reconciliation marker trên source; Step 9 mới materialize marker thành bounded jobs; mọi marker mutation CAS exact version/status/cursor để worker N không ghi lên N+1; browser không tự gửi `reviewedAt/reviewedBy`.

#### 5.8.4. Quản lý ingestion

Admin có thể:

- xem danh sách job và trạng thái `queued`, `running`, `succeeded`, `partial`, `failed` hoặc `cancelled`;
- xem nguồn, thời gian bắt đầu/kết thúc, số item mới, trùng, bỏ qua và lỗi;
- yêu cầu chạy đồng bộ thủ công cho một nguồn đã được duyệt;
- retry một job thất bại hoặc partial mà không tạo bản ghi trùng;
- hủy job đang chờ và yêu cầu dừng an toàn đối với job đang chạy nếu worker hỗ trợ;
- tạm dừng lịch chạy của nguồn gặp lỗi liên tiếp.

Mỗi lần chạy phải lấy canonical lock `ingestion:source:<sourceId>`, lưu actor-scoped idempotency key + request hash và giới hạn số item. Cron/admin/retry cùng source phải contend trên key này, không derive key từ job/invocation/actor. Job capture source policy/config version trước fetch; final article/checkpoint transaction match current source ID/version/active/eligible/config, mismatch thì discard candidate và không advance checkpoint. Queued work có `availableAt`; coordinator dùng priority trong từng queue, reserved progress cho mỗi registered due queue rồi mới spill budget. Mỗi lần lấy lease tăng generation và stale worker không được ghi checkpoint/artifact.

Admin không được nhìn thấy API key, access token hoặc secret trong dashboard và log. Lỗi hiển thị cho admin cần đủ để xử lý nhưng phải redact secret và dữ liệu nhạy cảm.

#### 5.8.5. Quản lý bài viết và AI index

Admin có thể:

- xem trạng thái bài: `processing`, `review-needed`, `published`, `hidden` hoặc `removed`;
- xem hàng đợi `review-needed` cho các trường hợp như quyền sử dụng thay đổi, dữ liệu trích xuất bất thường, bản trùng chưa chắc chắn hoặc kiểm tra AI thất bại;
- sửa topic và cấp độ xác thực do hệ thống phân loại sai;
- hợp nhất các bản ghi trùng nhưng phải giữ liên kết tới tất cả nguồn gốc;
- ẩn hoặc khôi phục bài khi phù hợp;
- yêu cầu tạo lại summary khi summary lỗi hoặc không bám nguồn;
- xem trạng thái index: `pending`, `indexed`, `failed` hoặc `removed`;
- yêu cầu retry indexing hoặc gỡ bài khỏi index;
- xem embedding model, version và thời điểm index gần nhất;
- xem lý do summary/indexing thất bại.
- xem `leadMedia`, host/mode/policy version và ẩn media riêng khi link lỗi, attribution thiếu hoặc quyền thay đổi mà không bắt buộc ẩn cả article.

Các invariant bắt buộc:

- chỉ bài `published` mới được xuất hiện trong feed, search result hoặc AI retrieval;
- bài `review-needed`, `hidden` hoặc `removed` không được đưa vào câu trả lời AI;
- khi article, summary hoặc quyền sử dụng thay đổi, index tương ứng phải được cập nhật hoặc vô hiệu hóa;
- embedding chỉ được tạo từ trường đã được phép; đổi embedding model/version bắt buộc re-index toàn bộ document liên quan;
- bài chỉ được khôi phục/index lại khi source và `licenseStatus` vẫn hợp lệ;
- media chỉ được serialize khi current source media policy vẫn hợp lệ; media `not-analyzed` không được đưa vào index hoặc AI evidence;
- admin không sửa nội dung gốc để làm thay đổi phát biểu của tác giả;
- hard delete chỉ dùng khi có yêu cầu bản quyền, quyền riêng tư hoặc nghĩa vụ pháp lý. Thao tác vận hành thông thường ưu tiên hide/soft delete để có thể phục hồi.

#### 5.8.6. Xử lý yêu cầu gỡ nội dung và quản lý user

Admin có thể:

- tạo và theo dõi yêu cầu gỡ với trạng thái `received`, `reviewing`, `approved`, `rejected` hoặc `completed`;
- lưu người yêu cầu, nội dung liên quan, lý do, bằng chứng và kết quả xử lý;
- khi yêu cầu được chấp thuận, ẩn hoặc xóa metadata, media reference, summary và embedding liên quan rồi cập nhật index;
- tìm user theo ID hoặc email và xem các trường vận hành tối thiểu như role, trạng thái và ngày tạo;
- quản lý trạng thái tài khoản `active`, `suspended`, `deletion-pending` hoặc `deleted`;
- khóa hoặc mở khóa tài khoản user vi phạm quy định sử dụng; khi khóa phải vô hiệu hóa các session hiện có;
- xử lý yêu cầu xóa tài khoản và dữ liệu liên quan theo chính sách lưu giữ dữ liệu của dự án.

Hai workflow không được trộn:

- content takedown chỉ áp dụng cho source/article và duyệt toàn bộ hoặc từ chối toàn bộ requested metadata/media/summary/embedding scope;
- account deletion là automatic durable workflow riêng: revoke session trước, sau đó direct-delete và zero-match session document, xóa saved/chat/user Q&A quota data, anonymize identity và chỉ `completed` khi các flag `sessionsRevoked`, `sessionsDeleted`, `userQuotaDataDeleted` cùng mọi cleanup flag khác đã được xác minh; shared IP anti-abuse bucket không thuộc cleanup;
- API xóa tài khoản không nhận free-form reason; server tự derive category an toàn `user-request`. TTL chỉ là cleanup best-effort, không phải bằng chứng hoàn tất workflow;
- expired/admin retry account deletion requeue cùng stable request, tăng attempt và giữ completion flags; không tạo linked child;
- takedown chỉ completed sau khi historical chat citations được chuyển thành `unavailable` không còn URL/title; delayed Q&A phải match active user/session version và article lifecycle ở final persistence;
- admin chỉ theo dõi safe progress/error và retry item còn thiếu; không đọc deleted email/chat hoặc phê duyệt yêu cầu xóa tài khoản.

Admin không được xem mật khẩu, auth token hoặc secret của user; không mặc nhiên được đọc lịch sử chat riêng tư; và không được mạo danh user.

#### 5.8.7. Audit log và thao tác nguy hiểm

Mỗi thao tác quản trị làm thay đổi trạng thái phải tạo audit log tối thiểu gồm:

```text
actorType
actorId
action
targetType
targetId
changedFields
stateTransition
reasonCode
requestId
result
createdAt
```

- Các thao tác tắt nguồn, hủy job, ẩn/xóa bài, xóa index và khóa user phải yêu cầu xác nhận cùng action-specific `reasonCode`; UI hiển thị label dễ hiểu nhưng không nhận free-form audit reason.
- Audit log chỉ được đọc bởi admin và không được chỉnh sửa qua dashboard.
- Audit không lưu raw before/after document, free-form requester/account case text, requester PII, email, password/session, private chat, provider payload hoặc source content. Direct mutation và audit dùng cùng transaction-capable Mongo client/session; role chỉ cho insert/find trên audit/suppression collections. Terminal deletion/takedown atomically ghi signed minimized target vào logical `techpulse_governance` DB; app restore không overwrite DB này.
- Dashboard không hiển thị password hash, session ID, API key, LLM key hoặc stack trace chứa secret.

#### 5.8.8. Bề mặt dashboard MVP

```text
Admin Dashboard
├── Overview
├── Sources
├── Ingestion Jobs
├── Articles & AI Index
├── Takedown Requests
├── Account Deletions
├── Users
└── Audit Logs
```

`Overview` chỉ cần hiển thị các số liệu giúp admin biết việc nào cần xử lý: nguồn đang bật/tạm dừng/chờ duyệt quyền, job đang chờ/thất bại, bài `review-needed`, index thất bại, yêu cầu gỡ chưa hoàn tất và account deletion bị lỗi cần retry.

MVP không cần `superadmin`, phân quyền chi tiết cho từng admin, SSO hoặc workflow nhiều người phê duyệt. Dashboard cũng không cho sửa system prompt, chọn tùy ý model/API endpoint, xem API key hoặc tải lên mã connector; các cấu hình này thuộc lớp triển khai của backend.

### 5.9. Ngôn ngữ và dịch

- UI, AI summary và AI Q&A của MVP dùng tiếng Việt.
- Hệ thống giữ `titleOriginal`, `excerptOriginal`, `sourceLanguage` và original URL; citation luôn trỏ tới nguồn nguyên bản.
- Chỉ title ngắn và summary được dịch/tạo bằng tiếng Việt; không dịch hoặc hiển thị lại toàn văn bài nguồn.
- Nguồn ở ngôn ngữ khác vẫn có thể được trích dẫn nếu pipeline tạo được summary tiếng Việt đủ chất lượng; lỗi dịch phải chuyển `summaryStatus` sang `failed` hoặc `review-needed`.
- Tiếng Anh là ngôn ngữ UI/output được ưu tiên bổ sung sau khi MVP tiếng Việt ổn định; các ngôn ngữ output khác nằm ở giai đoạn sau.

## 6. Phạm vi kỹ thuật dự kiến

- **Language:** JavaScript/JSX (`.js`, `.jsx`) để bám sát học phần; không dùng TypeScript/TSX trong MVP. OpenAPI runtime validation, generated JavaScript client/JSDoc và test giữ frontend/backend đồng bộ.
- **Frontend:** React với JavaScript/JSX, ưu tiên Vite.
- **Backend:** Node.js/Express bằng JavaScript, triển khai dưới dạng Vercel Function.
- **Hosting:** một Vercel Hobby project cho frontend, API và cron endpoint; đây là deployment phi thương mại, tạm thời phục vụ demo/chấm đồ án.
- **Database:** MongoDB Atlas Free; không lưu session, job hoặc dữ liệu lâu dài trên filesystem của function.
- **Keyword search:** MongoDB text index với `default_language: "none"`, trường `searchTextNormalized` và index cho status/source/topic/time.
- **Embedding:** OpenRouter Embeddings API với model `baai/bge-m3`, 1024 dimensions; input gồm title, `summaryVi` và topics.
- **Semantic retrieval:** lưu vector trong MongoDB và tính cosine similarity trong Node.js cho tập dữ liệu khoảng 250–400 bài; MongoDB Atlas Vector Search chưa phải dependency của MVP.
- **LLM:** OpenCode Zen free mặc định là `nonconfidential`, chỉ dùng source-derived input được Source Policy cho phép. Raw Q&A chỉ đi route có current `zdr-verified` evidence; fallback `deepseek-v4-flash` không được hạ privacy capability hoặc bypass admission/support gate.
- **Scheduler:** Vercel Cron một lần mỗi ngày và endpoint chạy thủ công có bảo vệ cho admin.
- **MVP connectors:** RSS/Atom, arXiv API và Hacker News API.

Tham khảo kỹ thuật chính:

- [Vercel Express](https://vercel.com/docs/frameworks/backend/express), [Vercel Cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing) và [quản lý Cron Job](https://vercel.com/docs/cron-jobs/manage-cron-jobs);
- [OpenRouter Embeddings API](https://openrouter.ai/docs/api/reference/embeddings) và [BAAI/bge-m3](https://openrouter.ai/baai/bge-m3);
- [MongoDB text index](https://www.mongodb.com/docs/manual/core/indexes/index-types/index-text/create-text-index/) và [`default_language: "none"`](https://www.mongodb.com/docs/manual/reference/operator/query/text/index.html).

Ràng buộc triển khai Vercel:

- không dùng `node-cron`, queue trong memory hoặc giả định có một process chạy liên tục;
- không dùng rate-limit/quota counter theo process; login, AI Q&A, admin trigger và source test dùng shared Mongo bucket hoặc platform limiter tương đương;
- protected `GET /api/internal/cron/due-work` recover expired jobs rồi xử lý ingestion/indexing/account-deletion queues và trả aggregate; admin POST trigger gọi chung runner nhưng dùng trust boundary riêng;
- mỗi job có actor/key/request-hash idempotency, `availableAt`, lease generation, batch size và trạng thái bền vững trong MongoDB;
- Q&A có actor/session-scoped idempotency receipt 24 giờ, một quota reservation và Mongo admission domain: mọi route dùng cùng provider credential tranh chung concurrency/budget, circuit vẫn per-route; cùng key/hash không gọi provider hoặc append chat lần hai;
- mỗi canonical logical lease key giữ persistent `generationHighWater` và nullable active owner, không dùng TTL; ingestion/indexing crash recovery terminal parent + linked retry, account deletion requeue same request; exact owner/generation heartbeat không được resurrect expired lease;
- coordinator đăng ký ingestion/indexing/account-deletion adapters, cấp reserved progress cho mỗi due queue rồi spill capacity; unregistered queue trả zero counter mà không query collection;
- ứng dụng tự quản lý retry vì Vercel không tự retry cron thất bại;
- code phải chịu được việc cùng một cron event được gửi nhiều lần;
- summary chạy non-streaming; Q&A có thể streaming nhưng phải fallback sang non-streaming khi cần;
- API key và provider URL chỉ nằm trong Vercel Environment Variables.

Các collection MongoDB dự kiến:

```text
users
sessions
rateLimitBuckets
sources
articles
savedArticles
ingestionJobs
indexingJobs
jobLeases
chatSessions
takedownRequests
accountDeletionRequests
adminAuditLogs
```

Mỗi embedding phải lưu kèm `embeddingModel`, `embeddingDimensions`, `embeddingInputHash`, `embeddingVersion`, `embeddingSourcePolicyVersion` và `embeddedAt`. Indexing job capture `expectedSourcePolicyVersion`; document/query phải dùng cùng model/version và artifact commit phải match current source policy. Đổi model bắt buộc tạo lại toàn bộ vector liên quan.

`nvidia/nemotron-3-embed-1b` là ứng viên thay thế nếu benchmark tiếng Việt tốt hơn hoặc BGE-M3 không khả dụng. Đây không phải runtime fallback: chuyển sang model khác phải tăng `embeddingVersion` và re-index toàn bộ corpus.

Embedding chỉ được tạo từ phần nội dung mà dự án có quyền xử lý. Provider embedding chỉ tạo vector, không thay thế Source Registry hoặc cấp thêm quyền sử dụng dữ liệu. OpenRouter nên tắt input/output logging, không opt-in sử dụng dữ liệu và ưu tiên Zero Data Retention khi endpoint hỗ trợ.

## 7. Tiêu chí hoàn thành MVP

MVP được xem là hoàn thành khi:

- Cả ba connector RSS/Atom, arXiv và Hacker News đều hoạt động end-to-end.
- Bản demo cấu hình được 8–10 RSS/Atom feed, 3 arXiv category/query cùng `topstories`, `newstories`, `beststories` của Hacker News mà không sửa logic lõi.
- Mỗi nguồn được kích hoạt đều có publisher, Terms/License URL, bằng chứng kiểm tra, cấp độ thẩm quyền, `licenseStatus`, `llmInputScope`, `storageScope` và chính sách citation.
- Mỗi nguồn có media policy rõ ràng; nguồn chưa review mặc định không preview ảnh/video.
- Nguồn không có quyền xử lý rõ ràng mặc định ở `metadata-only`; nguồn `review-needed` hoặc `blocked` không tạo job ingest.
- Luồng ingest → chuẩn hóa → lưu MongoDB → hiển thị React hoạt động end-to-end.
- Ảnh được phép remote-preview với alt/credit, ảnh thiếu/lỗi có TechPulse fallback; video quan trọng là link-only và ghi rõ AI chưa phân tích.
- Vercel Cron chạy được một batch mỗi ngày; admin trigger dùng chung logic, có lock và không tạo bản ghi trùng khi gọi lặp.
- Ứng dụng được deploy trên Vercel Hobby và toàn bộ state bền vững nằm trong MongoDB Atlas.
- Người dùng có thể tìm, lọc và lưu bài bằng text search ngay cả khi embedding provider không khả dụng.
- Semantic retrieval tạo được embedding BGE-M3, lưu đúng model/version và tìm top candidate bằng cosine similarity.
- AI tạo được title/summary tiếng Việt ngắn cho nội dung hợp lệ mà không lưu hoặc hiển thị toàn văn.
- AI Q&A trả lời bằng tiếng Việt từ dữ liệu truy xuất, dùng citation cấp đoạn; trang chi tiết/summary dùng citation cấp bài.
- Hệ thống từ chối trả lời khi không có bằng chứng phù hợp.
- Không gửi raw HTML hoặc phần không liên quan tới AI; `fulltext-temporary` chỉ dùng cho nguồn được phép và bị loại bỏ sau khi xử lý.
- MongoDB/log không có binary/base64 media; media host ngoài policy không xuất hiện trong user response và media không được dùng làm AI evidence.
- Có bộ câu hỏi kiểm thử để đánh giá độ đúng của citation, độ bám nguồn và khả năng từ chối.
- LLM provider có thể đổi bằng environment variable; lỗi Zen có thể fallback sang DeepSeek mà không đổi code nghiệp vụ.
- Admin đăng nhập được bằng tài khoản được seed; user thông thường bị từ chối tại mọi endpoint admin.
- Admin có thể tạo nguồn hợp lệ, yêu cầu chạy ingestion, xem lỗi, ẩn bài và retry indexing mà không truy cập trực tiếp vào worker hoặc secret.
- Chỉ bài `published` xuất hiện trong feed, search và AI retrieval; bài `review-needed`, `hidden` hoặc `removed` không bị rò rỉ qua bất kỳ bề mặt nào.
- Admin có thể xử lý một yêu cầu gỡ nội dung end-to-end; khi hoàn tất, metadata, summary và embedding thuộc phạm vi được duyệt bị loại bỏ đúng cách.
- Khi admin khóa một user, các session hiện có của user bị vô hiệu hóa và user không thể tiếp tục gọi API cần đăng nhập.
- Mọi thao tác quản trị thay đổi trạng thái đều tạo audit log có actor, target, lý do và kết quả.

Các chỉ số nên theo dõi trong quá trình đánh giá:

- tỷ lệ bài có đầy đủ nguồn và original URL;
- tỷ lệ citation trỏ đúng tài liệu hỗ trợ phát biểu;
- tỷ lệ truy vấn có nguồn hỗ trợ xuất hiện trong top 5 kết quả retrieval;
- số bản ghi trùng được phát hiện;
- tỷ lệ job ingest thành công;
- tỷ lệ source có hồ sơ Terms/License và ngày review hợp lệ;
- thời gian phản hồi của tìm kiếm và AI Q&A;
- số câu trả lời bị từ chối đúng khi thiếu bằng chứng.

## 8. Feature có thể phát triển trong tương lai

### 8.1. Mở rộng nguồn và nền tảng

- GitHub Connector cho metadata và release notes của repository có license rõ ràng.
- YouTube Data API cho video từ các kênh tổ chức chính thức.
- X API cho post từ các tài khoản chính thức, nếu ngân sách và điều khoản API phù hợp.
- Facebook Pages và Instagram Professional Accounts thông qua API chính thức và sau khi hoàn thành các yêu cầu quyền truy cập hoặc App Review.
- Các API báo chí hoặc nhà cung cấp dữ liệu có giấy phép phù hợp.
- Connector plugin để bổ sung nền tảng mới mà không thay đổi pipeline chuẩn hóa cốt lõi.
- Cơ chế xác minh tài khoản mạng xã hội bằng liên kết từ website chính thức, platform account ID và human review.
- Nội dung mạng xã hội thông thường chỉ được xem là tín hiệu; cần nguồn primary hoặc editorial độc lập trước khi nâng trạng thái xác thực.

### 8.2. Tổng hợp đa nguồn nâng cao

- Gom nhiều bài nói về cùng một sự kiện thành một cluster.
- Tạo timeline diễn biến của một chủ đề.
- So sánh cách nhiều nguồn mô tả cùng sự kiện.
- Phát hiện thông tin mâu thuẫn và hiển thị hai phía.

### 8.3. Cá nhân hóa

- Học từ chủ đề theo dõi và lịch sử đọc.
- Feed đề xuất cá nhân.
- Điều chỉnh độ dài và mức kỹ thuật của bản tóm tắt.
- Digest hằng ngày hoặc hằng tuần.

### 8.4. Khám phá xu hướng

- Dashboard chủ đề đang tăng nhanh.
- Biểu đồ tần suất công nghệ, framework hoặc công ty được nhắc đến.
- Knowledge graph liên kết công ty, sản phẩm, mô hình AI và sự kiện.
- Theo dõi thay đổi của một sản phẩm hoặc công nghệ theo thời gian.
- Chuyển semantic retrieval sang MongoDB Atlas Vector Search hoặc search service riêng khi dữ liệu vượt quy mô tính cosine trong Node.js.

### 8.5. Trải nghiệm nội dung

- Bổ sung UI, summary và AI Q&A bằng tiếng Anh sau khi bản tiếng Việt ổn định.
- Mở rộng thêm ngôn ngữ output khác dựa trên chất lượng model và nhu cầu người dùng.
- Official video embed theo điều khoản nền tảng; connector YouTube chính thức, transcript có quyền và AI image/video understanding có disclosure riêng.
- Media cache/object storage chỉ khi có license rõ, retention/takedown policy và ngân sách phù hợp.
- Chuyển bản tổng hợp thành audio hoặc podcast ngắn.
- PWA hoặc ứng dụng mobile.
- Browser extension để lưu và hỏi về bài đang đọc.
- Chia sẻ collection hoặc bản brief cho nhóm.

### 8.6. Responsible AI nâng cao

- Chấm điểm groundedness và citation coverage tự động.
- Nâng citation từ cấp bài/đoạn lên cấp từng claim đối với phát biểu quan trọng.
- Kiểm tra mức độ giống nhau giữa bản tóm tắt và bài gốc để hạn chế sao chép gần nguyên văn.
- Hiển thị mức độ chắc chắn dựa trên số lượng và chất lượng bằng chứng.
- Theo dõi thay đổi hoặc correction từ nguồn gốc.
- Có quy trình human review cho các chủ đề nhạy cảm.

### 8.7. Quản trị và vận hành nâng cao

- Multi-factor authentication cho admin.
- Nhiều admin với quyền chi tiết như source reviewer, content moderator và operator.
- `superadmin` chỉ để cấp hoặc thu hồi role quản trị.
- SSO cho tổ chức và chính sách session nâng cao.
- Workflow hai người phê duyệt đối với hard delete hoặc thay đổi chính sách nguồn.
- Dashboard chi phí LLM, quota connector, cảnh báo và health metrics.

### 8.8. Hướng thương mại hóa trong tương lai

- Workspace cho nhóm kỹ thuật hoặc doanh nghiệp.
- Theo dõi từ khóa, đối thủ hoặc công nghệ cụ thể.
- Báo cáo định kỳ và API cho khách hàng.
- Tích hợp Slack, Teams hoặc email.

Các feature thương mại chỉ được triển khai sau khi đánh giá lại toàn bộ giấy phép nguồn, hợp đồng API và nghĩa vụ trả tiền bản quyền.

## 9. Những nội dung không thuộc MVP

- Crawler toàn bộ Internet.
- GitHub Connector.
- Connector cho YouTube, X, Facebook và Instagram.
- Thu thập bài đăng từ tài khoản mạng xã hội cá nhân hoặc không được xác minh.
- Vượt paywall, CAPTCHA hoặc đăng nhập của website khác.
- Lưu trữ và phát lại toàn văn bài báo.
- Dịch hoặc công bố lại toàn văn nguồn sang tiếng Việt hay ngôn ngữ khác.
- Citation tự động ở cấp từng claim.
- Phụ thuộc bắt buộc vào MongoDB Atlas Search/Vector Search, Elasticsearch, Meilisearch hoặc Typesense.
- Sao chép hình ảnh, video hoặc logo khi chưa có quyền sử dụng.
- Download/cache/rehost media nguồn, arbitrary image proxy, official video embed, transcript extraction hoặc AI image/video analysis.
- Mạng xã hội nội bộ hoặc hệ thống bình luận phức tạp.
- Thanh toán, quảng cáo hoặc affiliate link.
- Cam kết rằng AI luôn đúng hoặc mọi nguồn đều hoàn toàn khách quan.
- Fine-tune một mô hình AI riêng trên dữ liệu báo chí không có giấy phép.

## 10. Lưu ý và ràng buộc pháp lý

> Phần này ghi lại nguyên tắc thiết kế cho đồ án, không thay thế tư vấn pháp lý chuyên nghiệp. Cần đánh giá lại trước khi triển khai công khai hoặc thương mại hóa.

### 10.1. Phi thương mại không đồng nghĩa với miễn bản quyền

Việc dự án phục vụ học tập và không kiếm tiền giúp giảm rủi ro trong một số trường hợp, nhưng không tự động cho phép sao chép, lưu trữ hoặc công bố lại tác phẩm của người khác.

Luật số 131/2025/QH15 cho phép sử dụng văn bản và dữ liệu đã được công bố, tiếp cận hợp pháp để phục vụ nghiên cứu khoa học, thử nghiệm hoặc huấn luyện hệ thống AI nếu không ảnh hưởng bất hợp lý đến quyền và lợi ích hợp pháp của tác giả, chủ sở hữu. Quy định này có hiệu lực từ ngày 01/04/2026. Xem [Luật số 131/2025/QH15](https://congbaocdn.chinhphu.vn/180507251028987904/2026/1/26/l131signed-1769414186338836371951.pdf).

Nghị định số 134/2026/NĐ-CP, có hiệu lực từ ngày 09/04/2026, yêu cầu thêm rằng:

- dữ liệu phải được công bố và truy cập hợp pháp;
- không được vô hiệu biện pháp công nghệ bảo vệ quyền;
- việc sử dụng phải không nhằm mục đích thương mại;
- không được mâu thuẫn với việc khai thác bình thường của tác phẩm;
- đầu ra AI không được thay thế thị trường của nội dung gốc;
- bên sử dụng phải lưu hồ sơ dữ liệu và tôn trọng quyền bảo lưu của chủ sở hữu.

Xem [Nghị định số 134/2026/NĐ-CP, Điều 37a–37c](https://congbao.cdnchinhphu.vn/180507251028987904/2026/4/29/469388-1777368984_v1_1777430941_signed.pdf).

Các quy định trên tạo cơ sở thuận lợi hơn cho một đồ án nghiên cứu hoặc thử nghiệm, nhưng không phải quyền sử dụng không giới hạn.

### 10.2. Dữ kiện khác với cách thể hiện của bài báo

“Tin tức thời sự thuần túy đưa tin”, số liệu và dữ kiện đơn thuần không thuộc phạm vi bảo hộ quyền tác giả. Tuy nhiên, bài phân tích, phỏng vấn, phóng sự, bình luận, ảnh, video và cách trình bày sáng tạo vẫn có thể được bảo hộ.

Vì vậy:

- AI nên tổng hợp dữ kiện bằng cách diễn đạt mới;
- không sao chép đoạn dài hoặc giữ nguyên cấu trúc bài gốc;
- không sử dụng hình ảnh nếu chưa có quyền;
- việc link đến trang nguồn không đồng nghĩa với quyền copy/rehost asset; remote-preview/embed vẫn phải theo license/Terms và yêu cầu attribution của nguồn;
- luôn ghi tên nguồn, tác giả nếu có và liên kết đến bài gốc;
- citation không tự động thay thế cho giấy phép sử dụng.

Tham khảo [Văn bản hợp nhất Luật Sở hữu trí tuệ, Điều 15](https://congbao.chinhphu.vn/tai-ve-van-ban-so-155-vbhn-vpqh-46214-58977?format=pdf) và giải thích của [Cục Bản quyền tác giả về tác phẩm báo chí](https://cov.gov.vn/quyen-tac-gia-quyen-lien-quan/tac-pham-bao-chi-hien-nay-co-duoc-bao-ho-quyen-tac-gia-khong-neu-co-thi-tac-pham-bao-chi-bao-gom-cac-the-loai-nao-thoi-han-bao-ho-cac-the-loai-tac-pham-bao-chi-do-trong-thoi-gian-bao-lau-168809.html).

### 10.3. Điều khoản API và website là một lớp ràng buộc riêng

Ngay cả khi một cách sử dụng có thể thuộc ngoại lệ của luật bản quyền, dự án vẫn phải kiểm tra điều khoản của API, RSS và website.

Đối với các connector của MVP:

- **RSS/Atom:** feed là một phương thức phân phối dữ liệu, không mặc nhiên là giấy phép tái xuất bản toàn bộ nội dung. Cần tuân theo điều khoản của từng publisher.
- **arXiv:** sử dụng API theo [điều khoản và hướng dẫn của arXiv](https://info.arxiv.org/help/api/index.html), ghi nhận nguồn theo yêu cầu và kiểm tra giấy phép riêng của từng paper trước khi xử lý full text.
- **Hacker News:** [API chính thức](https://github.com/HackerNews/API) cung cấp metadata, item và liên kết. Quyền truy cập HN không đồng thời cấp quyền sử dụng bài viết tại website được liên kết.

GitHub nằm ở hậu MVP. Khi bổ sung, public repository hoặc public release vẫn không tự động cấp quyền tái sử dụng; phải kiểm tra repository license và phạm vi áp dụng cho documentation/release notes.

Checklist kiểm tra một publisher/source:

1. Mở Terms of Use, Copyright, Content Licensing, Permissions và Privacy Policy ở footer.
2. Kiểm tra riêng API Terms hoặc RSS Terms của phương thức truy cập đang dùng.
3. Kiểm tra byline, copyright notice, Creative Commons và nội dung do bên thứ ba cung cấp ở cấp bài.
4. Tìm kênh licensing/contact hoặc văn bản chấp thuận nếu muốn xử lý vượt metadata/excerpt.
5. Lưu URL bằng chứng, kết luận, người kiểm tra và ngày kiểm tra trong Source Registry.

`robots.txt`, sitemap hoặc việc website cho đọc miễn phí không phải license. Nếu không tìm thấy quyền rõ ràng, hệ thống áp dụng `metadata-only`; chỉ nâng lên `fulltext-temporary` khi có bằng chứng phù hợp.

Ví dụ vận hành: với một publisher như CNN hoặc một trang báo tương tự, nếu chỉ tìm thấy bài công khai/RSS nhưng không có quyền xử lý full text bằng AI rõ ràng, nguồn vẫn ở `metadata-only`. Hệ thống chỉ dùng title, byline, ngày, original URL và excerpt chính thức; không lấy ảnh, video hoặc toàn văn để gửi provider.

Media được review riêng: URL công khai có thể được giữ làm liên kết tới trang nguồn, nhưng ảnh chỉ được remote-preview nếu Terms/license cho phép cách hiển thị đó và host nằm trong allowlist. Video MVP không được tải xuống hoặc phát lại; chỉ đặt link tới trang nguồn. Với nền tảng có cơ chế embed chính thức, việc embed vẫn phải tuân [YouTube API Services Terms and Developer Policies](https://developers.google.com/youtube/terms/developer-policies) hoặc điều khoản tương ứng và được để hậu MVP. Có thể tham khảo kênh hướng dẫn/quyền của [Cục Bản quyền tác giả](https://cov.gov.vn/giam-dinh-quyen-tac-gia-quyen-lien-quan/gioi-thieu-ve-dich-vu-giam-dinh-quyen-tac-gia-quyen-lien-quan-167148.html) khi phạm vi quyền không rõ.

Các connector mạng xã hội trong tương lai phải dùng API hoặc cơ chế embed chính thức, đồng thời tuân thủ quy định hiển thị, lưu trữ, xóa dữ liệu và attribution của từng nền tảng.

### 10.4. Gửi nội dung đến nhà cung cấp AI và embedding

Gửi dữ liệu đến LLM hoặc embedding API là một hình thức xử lý và truyền dữ liệu cho bên thứ ba. Trước khi thực hiện cần kiểm tra:

- nguồn có cho phép xử lý nội dung theo cách đó hay không;
- nhà cung cấp AI lưu dữ liệu trong bao lâu;
- dữ liệu có được dùng để huấn luyện mô hình hay không;
- khu vực lưu trữ và cơ chế xóa dữ liệu;
- nội dung có chứa dữ liệu cá nhân hoặc thông tin nhạy cảm hay không.

Quy tắc vận hành:

- Không gửi raw HTML hoặc phần không liên quan tới provider.
- User question qua privacy admission trước routing: credential/high-risk identifier bị từ chối, raw question chỉ dùng current `zdr-verified` route và primary/fallback nhận cùng admitted input.
- Nguồn `metadata-only` chỉ được gửi metadata; nguồn `blocked`, `review-needed` hoặc `llmInputScope: none` không được gửi dữ liệu nguồn tới provider.
- `fulltext-temporary` chỉ dùng cho nguồn có bằng chứng quyền xử lý rõ ràng, được làm sạch/chia chunk, không lưu lâu dài và không được dùng để thay thế bài gốc.
- Embedding không tạo thêm quyền sử dụng dữ liệu; input embedding phải tuân cùng Source Registry policy như input LLM.
- Với OpenCode Zen, model miễn phí có thể chỉ tồn tại tạm thời và một số free endpoint có thể dùng dữ liệu để cải thiện model; không gửi dữ liệu cá nhân, bí mật hoặc toàn văn chưa được phép. Xem [OpenCode Zen](https://opencode.ai/docs/zen).
- Với OpenRouter, tắt input/output logging, không opt-in dùng dữ liệu và ưu tiên endpoint [Zero Data Retention](https://openrouter.ai/docs/guides/features/zdr); dữ liệu vẫn được chuyển tới model provider nên phải kiểm tra policy của endpoint đó.

### 10.5. Bảo vệ dữ liệu cá nhân

- Chỉ thu thập dữ liệu tài khoản thực sự cần cho MVP.
- Không lưu mật khẩu dạng rõ.
- Có thông báo về dữ liệu được thu thập và mục đích sử dụng.
- Cho phép người dùng xóa tài khoản, lịch sử lưu bài và lịch sử chat.
- Không đưa email, token, API key hoặc dữ liệu cá nhân vào prompt và log.
- Đánh giá lại quy định bảo vệ dữ liệu cá nhân trước khi triển khai công khai.

### 10.6. Quy trình gỡ nội dung

Hệ thống cần có khả năng:

- tắt ngay một nguồn;
- xóa metadata, media reference, summary và embedding liên quan;
- lưu yêu cầu gỡ nội dung và kết quả xử lý;
- cập nhật lại index sau khi xóa;
- cung cấp kênh liên hệ cho chủ sở hữu quyền.

### 10.7. Chế độ triển khai đồ án

Phiên bản MVP được triển khai trên Vercel Hobby bằng một public URL tạm thời phục vụ demo/chấm đồ án. Dự án vẫn phải dùng tài khoản cho các chức năng cá nhân và không quảng bá như một dịch vụ tin tức thay thế publisher.

- Vercel Hobby phù hợp với project cá nhân, phi thương mại; cần đánh giá lại plan nếu có mục đích thương mại. Xem [Vercel Hobby](https://vercel.com/docs/plans/hobby).
- Có thể giữ bản local làm phương án dự phòng khi demo.
- Deployment không làm thay đổi `licenseStatus` hoặc mở rộng quyền xử lý nội dung.

Trước khi mở công khai cho mọi người hoặc thêm quảng cáo, affiliate, subscription hay khách hàng doanh nghiệp, phải đánh giá lại toàn bộ nguồn và quyền sử dụng.

## 11. Rủi ro chính

| Rủi ro | Cách giảm thiểu ban đầu |
|---|---|
| Vi phạm bản quyền hoặc điều khoản nguồn | Source allowlist, lưu bằng chứng Terms/License, thực thi `llmInputScope`, không lưu full text |
| Điều khoản publisher thay đổi sau khi duyệt | Lưu `reviewedAt`, URL bằng chứng; chuyển `review-needed` và tạm ingest khi phát hiện thay đổi quan trọng |
| Gửi dữ liệu vượt phạm vi tới LLM/embedding provider | Policy check phía backend trước mọi request, redact dữ liệu, ưu tiên ZDR và audit model/scope |
| AI hallucination | RAG, citation, từ chối khi thiếu bằng chứng, bộ kiểm thử groundedness |
| Prompt injection từ bài viết | Coi nội dung nguồn là dữ liệu, tách system instruction, lọc và giới hạn tool |
| Tin trùng | Canonical URL, hash và semantic similarity |
| Tin cũ hoặc sai thời điểm | Hiển thị `publishedAt`, `retrievedAt` và phạm vi thời gian truy vấn |
| Chi phí LLM | Cache summary, giới hạn độ dài input, batch job và quota người dùng |
| API thay đổi hoặc hết quota | Adapter riêng cho từng nguồn, retry giới hạn và khả năng tắt nguồn |
| Vercel Cron chạy trùng, lỗi hoặc hết thời gian | Idempotency key, distributed lock, batch nhỏ, app-level retry và nút chạy thủ công |
| Embedding provider lỗi | Fallback về MongoDB text search; đánh dấu `embeddingStatus: failed` để retry sau |
| Đổi embedding model làm vector không tương thích | Pin model/dimension/version và re-index toàn bộ document khi thay đổi |
| Nội dung cộng đồng bị nhầm là thông tin đã xác thực | Gắn Hacker News là `community-signal`, chỉ feed/search và loại khỏi Q&A evidence trong MVP |
| Bản tóm tắt thay thế bài gốc | Tóm tắt ngắn, không dùng toàn văn/media làm evidence; nút đọc nguồn nổi bật |
| Ảnh/video công khai bị dùng vượt quyền | Media policy độc lập, allowlisted HTTPS host, remote-preview/link-only, attribution và không rehost |
| Ảnh hotlink hỏng hoặc publisher chặn | Lazy-load và TechPulse-owned fallback; không proxy tùy ý để che lỗi |
| AI suy diễn từ media chưa xử lý | `mediaEvidenceStatus=not-analyzed`; loại media khỏi summary/embedding/Q&A input |
| Dịch/tóm tắt sai nguồn ngoại ngữ | Giữ title/ngôn ngữ/URL gốc, gắn nhãn AI, đưa lỗi chất lượng vào `review-needed` |
| User chiếm quyền hoặc gọi trực tiếp admin API | Kiểm tra role tại backend, session an toàn, CSRF protection, rate limiting và test `401/403` |
| Source URL độc hại truy cập mạng nội bộ | Chỉ HTTPS/no credential; validate toàn bộ DNS answers, reject mixed/mapped/private, pin socket vào IP đã duyệt và tự xử lý redirect |
| Bài chưa duyệt hoặc đã ẩn vẫn còn trong AI index | Chỉ index trạng thái `published`, đồng bộ article/index và kiểm thử các invariant trạng thái |
| Admin thao tác nhầm hoặc khó truy vết | Ưu tiên soft delete, yêu cầu xác nhận/action-specific reasonCode và ghi audit log append-only không chứa free-form case text |

## 12. Việc cần xác nhận khi triển khai

Không còn câu hỏi sản phẩm nào chặn việc chuyển sang PRD và thiết kế kỹ thuật. Các việc sau được xác nhận trong lúc triển khai:

- chọn chính xác 8–10 RSS/Atom feed và hoàn thành hồ sơ Terms/License cho từng feed;
- seed ba arXiv query ban đầu (`cs.AI`, `cs.MA`, `cs.RO`) và điều chỉnh nếu dữ liệu demo mất cân bằng;
- kiểm tra availability/quota hiện tại của OpenCode Zen, DeepSeek, OpenRouter và Vercel trước ngày demo;
- benchmark BGE-M3 bằng một bộ câu hỏi tiếng Việt nhỏ trước khi cố định `embeddingVersion: 1`;
- chốt thời điểm tắt deployment Vercel tạm thời sau khi hoàn thành việc chấm đồ án.

## 13. Quyết định hiện tại

- **Go** với ý tưởng TechPulse AI.
- Thời gian dự kiến là 4 tuần; project owner thực hiện theo solo-owner nhưng làm cùng coding agent, vì vậy không pre-cut scope chỉ từ estimate. Milestone thực tế mới kích hoạt mutation; safety/contract gate không hạ.
- Ưu tiên một MVP nhỏ, khoảng 250–400 bài, có nguồn rõ ràng và luồng AI có citation.
- Chốt ba nhóm nguồn cho MVP: RSS/Atom, arXiv và Hacker News.
- GitHub, YouTube, X, Facebook, Instagram và các nền tảng khác được chuyển sang giai đoạn hoàn thiện sau MVP.
- Bản demo dự kiến bật 8–10 RSS feed, 3 arXiv query và ba luồng Hacker News `topstories`, `newstories`, `beststories`.
- Số lượng source definition có thể tăng qua Source Registry mà không cần thêm connector mới.
- Triển khai React + Node.js/Express trên Vercel Hobby; MongoDB Atlas lưu toàn bộ state bền vững.
- Implementation dùng JavaScript/JSX (`.js`, `.jsx`), không dùng TypeScript/TSX trong MVP; contract được bảo vệ bằng OpenAPI/runtime validation/JSDoc và test.
- Ingestion chạy một lần mỗi ngày bằng protected Vercel Cron GET adapter và có admin POST trigger; job có actor/key/request-hash idempotency, due-time coordinator, lease-generation fencing và batch giới hạn.
- Keyword search dùng MongoDB text index và trường bỏ dấu; không phụ thuộc MongoDB Atlas Search/Vector Search trong MVP.
- Semantic retrieval dùng `baai/bge-m3` qua OpenRouter, lưu vector 1024 chiều trong MongoDB và tính cosine similarity trong Node.js; đây là planned-MVP release gate của grounded Q&A, còn text search là degradation fallback.
- LLM ưu tiên `deepseek-v4-flash-free` qua OpenCode Zen và có fallback cấu hình sang `deepseek-v4-flash` trả phí thấp.
- UI, summary và AI Q&A dùng tiếng Việt; giữ nguyên title, ngôn ngữ và URL nguồn; chỉ dịch/tạo summary, không dịch toàn văn.
- Citation cấp bài được dùng ở trang chi tiết/summary; citation cấp đoạn được dùng trong AI Q&A; citation cấp từng claim là hậu MVP.
- Source Registry phân biệt publisher, license, access method và operational status; không tìm thấy quyền rõ ràng thì mặc định `metadata-only`.
- Chỉ nguồn `fulltext-temporary` được phép xử lý main content đã làm sạch/chia chunk; không gửi raw HTML và không lưu toàn văn.
- Media policy độc lập với quyền xử lý text: ảnh chỉ remote-preview từ host đã duyệt, video chỉ link tới nguồn, không rehost binary và AI không phân tích media trong MVP.
- Việc kiểm tra kỹ thuật nguồn được tự động hóa; việc kết luận Terms/License và phạm vi AI do admin phê duyệt.
- MVP có hai role người dùng `user` và `admin`; `system-worker` là actor nội bộ, không phải tài khoản đăng nhập.
- Admin dùng authentication backend chung, giao diện `/admin` riêng và server-side session; role luôn được kiểm tra ở backend.
- Admin đầu tiên được tạo bằng seed script; không cho đăng ký hoặc tự nâng role admin qua UI/API.
- Pipeline tự xuất bản bản ghi hợp lệ; admin chỉ xử lý cấu hình, lỗi và các bản ghi `review-needed`, không duyệt từng bài trong luồng bình thường.
- Mọi thao tác quản trị thay đổi trạng thái phải có safe structured audit với action-specific `reasonCode`; chỉ bài `published` và artifact `ready` ở current source policy version được xuất hiện trong feed, search và AI retrieval.
- Content takedown all-or-nothing tách khỏi automatic account deletion; takedown có historical-citation redaction evidence, account deletion có same-request completion evidence và delayed-write fence.
- Grounded answer dùng hai contract state loại trừ nhau: answered bắt buộc paragraph/citation, refused bắt buộc reason và không có factual paragraph.
- Xem quản trị nguồn và responsible AI là năng lực cốt lõi của sản phẩm.
- Không xây sản phẩm dựa trên việc “lách luật” hoặc giả định rằng phi thương mại đồng nghĩa với được phép sử dụng mọi nội dung.
- Bộ tài liệu PRD, architecture, data model, OpenAPI, ADR và kế hoạch 4 tuần đã phản ánh Plan-of-Record baseline v1.7: JavaScript/JSX, strict browser/API/XML/provider boundaries, indexed governance cleanup/restore gate, ADR-0010 persistent fencing, ADR-0011 canonical coordination/recovery/fairness và ADR-0012 privacy cleanup/retention boundary. Step 1 phải đóng contract classification/400/503 cùng ingress fixtures trước Step 2.
