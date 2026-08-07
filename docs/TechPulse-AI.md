# TechPulse AI

> Trạng thái: Ý tưởng thô / tài liệu sống  
> Cập nhật lần đầu: 07/08/2026  
> Mục đích: Lưu định hướng sản phẩm, phạm vi MVP, hướng phát triển và các ràng buộc quan trọng trước khi viết PRD hoặc thiết kế kỹ thuật chi tiết.

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

- tên nguồn và domain;
- URL API, RSS/Atom hoặc định danh repo/query tương ứng;
- loại nguồn và loại connector;
- cấp độ thẩm quyền của nguồn: `primary`, `editorial` hoặc `community-signal`;
- trạng thái bật/tắt;
- phạm vi nội dung được phép sử dụng;
- loại giấy phép hoặc điều khoản liên quan;
- URL điều khoản sử dụng;
- ngày kiểm tra điều khoản gần nhất;
- ghi chú về attribution;
- trạng thái `permitted`, `metadata-only`, `review-needed` hoặc `blocked`.

Hệ thống không được ingest nguồn có trạng thái `blocked` hoặc chưa được duyệt.

### 5.3. Pipeline thu thập dữ liệu

- Pipeline được thiết kế theo kiến trúc connector; số lượng nguồn không bị hard-code trong ứng dụng.
- MVP chỉ triển khai bốn nhóm connector:
  - **RSS/Atom Connector:** nhận dữ liệu từ nhiều feed báo chí, blog công nghệ, research lab và website tổ chức đã được duyệt trong Source Registry;
  - **arXiv Connector:** nhận metadata và abstract theo category hoặc truy vấn được cấu hình; chỉ xử lý full text khi giấy phép của paper cho phép;
  - **GitHub Connector:** nhận metadata và release notes từ danh sách public repository được chọn;
  - **Hacker News Connector:** nhận các item từ API chính thức như `topstories`, `newstories` và `beststories` để phát hiện xu hướng cộng đồng.
- Hacker News được xem là nguồn `community-signal`. Bài viết được liên kết từ HN phải được kiểm tra như một nguồn độc lập; không mặc nhiên được lưu toàn văn hoặc dùng làm bằng chứng duy nhất.
- Chỉ dùng API chính thức, RSS/Atom hoặc phương thức truy cập được nguồn cho phép.
- Chạy theo lịch định kỳ bằng Node.js.
- Chuẩn hóa dữ liệu về một schema chung.
- Lưu log cho mỗi lần ingest: nguồn, thời gian, số bản ghi thành công, số bản ghi lỗi và lý do lỗi.
- Có retry giới hạn, rate limiting và cơ chế tắt nhanh một nguồn gặp vấn đề.

Metadata tối thiểu của một bài:

```text
title
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
language
topics
excerpt
aiSummary
contentScope
licenseStatus
```

Không lưu toàn bộ nội dung bài viết có bản quyền nếu chưa có quyền sử dụng rõ ràng.

### 5.4. Chuẩn hóa, phân loại và chống trùng

- Chuẩn hóa canonical URL và thời gian xuất bản.
- Phát hiện bản ghi trùng bằng URL, content hash và độ tương đồng tiêu đề.
- Phân loại tối thiểu theo các chủ đề đã xác định.
- Cho phép admin sửa chủ đề hoặc hợp nhất bản ghi bị trùng sai.

### 5.5. News Feed và tìm kiếm

- Feed mới nhất theo chủ đề.
- Lọc theo nguồn, chủ đề và khoảng thời gian.
- Tìm kiếm theo tiêu đề, mô tả và bản tóm tắt được phép lưu.
- Phân trang hoặc infinite scroll có kiểm soát.
- Mỗi card phải hiển thị tên nguồn, tác giả nếu có, ngày xuất bản và liên kết bài gốc.

### 5.6. Trang chi tiết tin

- Tiêu đề, nguồn, tác giả, ngày xuất bản và ngày hệ thống thu thập.
- Bản tóm tắt AI ngắn, dùng cách diễn đạt mới.
- Chủ đề được hệ thống phân loại.
- Nút **Đọc bài gốc** được đặt nổi bật.
- Thông báo rằng nội dung được AI tổng hợp và có thể cần kiểm chứng.
- Không hiển thị lại toàn bộ bài viết hoặc hình ảnh nếu nguồn không cho phép.

### 5.7. AI Q&A có citation

- Người dùng có thể hỏi về một bài, một chủ đề hoặc một khoảng thời gian.
- Backend truy xuất dữ liệu phù hợp trước khi gọi mô hình AI.
- Câu trả lời chỉ được sử dụng phần dữ liệu có `licenseStatus` phù hợp.
- Mỗi kết luận quan trọng phải gắn citation đến bài gốc.
- Hiển thị tên nguồn và ngày xuất bản cùng citation.
- Nếu nhiều nguồn mâu thuẫn, phải trình bày sự khác biệt thay vì tự chọn một nguồn là đúng.
- Nếu không đủ dữ liệu, trả lời rõ rằng hệ thống chưa có đủ bằng chứng.
- Không cho phép mô hình làm theo chỉ dẫn nằm trong nội dung bài viết được ingest.

### 5.8. Trang quản trị tối thiểu

Trang quản trị là bề mặt vận hành nội bộ của TechPulse AI. Phần lớn pipeline vẫn chạy tự động; admin dùng dashboard để cấu hình, giám sát và xử lý ngoại lệ. Bản ghi hợp lệ được pipeline tự động xuất bản, vì vậy admin không phải duyệt thủ công từng bài trong luồng bình thường.

#### 5.8.1. Actor và ranh giới quyền

| Năng lực | `user` | `admin` | `system-worker` |
|---|---:|---:|---:|
| Xem feed, tìm kiếm, lưu bài và hỏi AI | Có | Có | Không |
| Quản lý nguồn và chính sách sử dụng | Không | Có | Chỉ đọc cấu hình đã duyệt |
| Yêu cầu chạy hoặc retry ingestion/indexing | Không | Có | Không |
| Thực thi ingestion, summary và indexing job | Không | Không | Có |
| Ẩn bài, sửa topic, hợp nhất bản trùng | Không | Có | Không |
| Xử lý yêu cầu gỡ nội dung và khóa user | Không | Có | Không |
| Ghi audit/operational log | Không | Tạo qua thao tác | Tạo qua quá trình chạy job |

- `system-worker` là danh tính nội bộ của backend, không phải tài khoản có thể đăng nhập vào giao diện.
- Admin không chạy connector trực tiếp trong HTTP request. Admin chỉ tạo job; worker lấy job từ hàng đợi hoặc database để thực thi.
- Worker không sử dụng session hoặc mật khẩu của admin.

#### 5.8.2. Đăng nhập và bảo vệ trang admin

- Admin đăng nhập bằng tài khoản có role `admin` thông qua cùng authentication backend với user.
- Có thể dùng giao diện riêng `/admin/login` và `/admin`, nhưng URL riêng không được xem là biện pháp bảo mật.
- Phương án mặc định cho MVP là server-side session với session ID trong cookie `HttpOnly`, `SameSite` và `Secure` khi chạy HTTPS; không lưu auth token trong `localStorage`.
- Mọi endpoint `/api/admin/*` phải kiểm tra authentication và role tại backend. Chỉ ẩn nút hoặc route ở React là không đủ.
- Chưa đăng nhập trả về `401`; đã đăng nhập nhưng không phải admin trả về `403`.
- Tài khoản admin đầu tiên được tạo bằng seed script hoặc thao tác triển khai có kiểm soát; không có API đăng ký admin công khai và không có giao diện đổi role trong MVP.
- Login và các thao tác tốn tài nguyên phải có input validation, rate limiting và bảo vệ CSRF phù hợp với cơ chế session.

#### 5.8.3. Quản lý nguồn

Admin có thể:

- tạo và cập nhật source definition cho RSS/Atom, arXiv, GitHub hoặc Hacker News;
- kiểm tra kết nối trước khi bật nguồn;
- cấu hình connector, URL/feed, repo, category/query, lịch chạy và cấp độ thẩm quyền;
- ghi nhận `licenseStatus`, điều khoản, attribution và phạm vi nội dung được phép xử lý;
- bật, tạm dừng, chặn hoặc lưu trữ một nguồn;
- xem lần ingest thành công gần nhất và lỗi gần nhất của nguồn.

Ràng buộc:

- nguồn `review-needed` hoặc `blocked` không được tạo ingestion job mới;
- `metadata-only` chỉ được xử lý trong phạm vi metadata được phép;
- URL do admin nhập vẫn phải được validate; backend chỉ cho phép protocol và host phù hợp, đồng thời chặn truy cập địa chỉ nội bộ để giảm nguy cơ SSRF;
- credential của connector, nếu có, được cấu hình bằng biến môi trường hoặc hệ thống secret khi triển khai; admin không nhập hoặc đọc secret trực tiếp trên dashboard;
- tắt nguồn chỉ dừng lần ingest tiếp theo, không tự động xóa dữ liệu cũ. Việc giữ, ẩn hoặc xóa dữ liệu đã có phải là quyết định riêng và được audit.

#### 5.8.4. Quản lý ingestion

Admin có thể:

- xem danh sách job và trạng thái `queued`, `running`, `succeeded`, `partial`, `failed` hoặc `cancelled`;
- xem nguồn, thời gian bắt đầu/kết thúc, số item mới, trùng, bỏ qua và lỗi;
- yêu cầu chạy đồng bộ thủ công cho một nguồn đã được duyệt;
- retry một job thất bại hoặc partial mà không tạo bản ghi trùng;
- hủy job đang chờ và yêu cầu dừng an toàn đối với job đang chạy nếu worker hỗ trợ;
- tạm dừng lịch chạy của nguồn gặp lỗi liên tiếp.

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
- xem lý do summary/indexing thất bại.

Các invariant bắt buộc:

- chỉ bài `published` mới được xuất hiện trong feed, search result hoặc AI retrieval;
- bài `review-needed`, `hidden` hoặc `removed` không được đưa vào câu trả lời AI;
- khi article, summary hoặc quyền sử dụng thay đổi, index tương ứng phải được cập nhật hoặc vô hiệu hóa;
- bài chỉ được khôi phục/index lại khi source và `licenseStatus` vẫn hợp lệ;
- admin không sửa nội dung gốc để làm thay đổi phát biểu của tác giả;
- hard delete chỉ dùng khi có yêu cầu bản quyền, quyền riêng tư hoặc nghĩa vụ pháp lý. Thao tác vận hành thông thường ưu tiên hide/soft delete để có thể phục hồi.

#### 5.8.6. Xử lý yêu cầu gỡ nội dung và quản lý user

Admin có thể:

- tạo và theo dõi yêu cầu gỡ với trạng thái `received`, `reviewing`, `approved`, `rejected` hoặc `completed`;
- lưu người yêu cầu, nội dung liên quan, lý do, bằng chứng và kết quả xử lý;
- khi yêu cầu được chấp thuận, ẩn hoặc xóa metadata, summary và embedding liên quan rồi cập nhật index;
- tìm user theo ID hoặc email và xem các trường vận hành tối thiểu như role, trạng thái và ngày tạo;
- quản lý trạng thái tài khoản `active`, `suspended`, `deletion-pending` hoặc `deleted`;
- khóa hoặc mở khóa tài khoản user vi phạm quy định sử dụng; khi khóa phải vô hiệu hóa các session hiện có;
- xử lý yêu cầu xóa tài khoản và dữ liệu liên quan theo chính sách lưu giữ dữ liệu của dự án.

Admin không được xem mật khẩu, auth token hoặc secret của user; không mặc nhiên được đọc lịch sử chat riêng tư; và không được mạo danh user.

#### 5.8.7. Audit log và thao tác nguy hiểm

Mỗi thao tác quản trị làm thay đổi trạng thái phải tạo audit log tối thiểu gồm:

```text
adminId
action
targetType
targetId
before
after
reason
ipAddress
result
createdAt
```

- Các thao tác tắt nguồn, hủy job, ẩn/xóa bài, xóa index và khóa user phải yêu cầu xác nhận cùng lý do.
- Audit log chỉ được đọc bởi admin và không được chỉnh sửa qua dashboard.
- Dashboard không hiển thị password hash, session ID, API key, LLM key hoặc stack trace chứa secret.

#### 5.8.8. Bề mặt dashboard MVP

```text
Admin Dashboard
├── Overview
├── Sources
├── Ingestion Jobs
├── Articles & AI Index
├── Takedown Requests
├── Users
└── Audit Logs
```

`Overview` chỉ cần hiển thị các số liệu giúp admin biết việc nào cần xử lý: nguồn đang bật/tạm dừng, job đang chờ/thất bại, bài `review-needed`, index thất bại và yêu cầu gỡ chưa hoàn tất.

MVP không cần `superadmin`, phân quyền chi tiết cho từng admin, SSO hoặc workflow nhiều người phê duyệt. Dashboard cũng không cho sửa system prompt, chọn tùy ý model/API endpoint, xem API key hoặc tải lên mã connector; các cấu hình này thuộc lớp triển khai của backend.

## 6. Phạm vi kỹ thuật dự kiến

- **Frontend:** React.
- **Backend:** Node.js và Express hoặc framework Node.js tương đương.
- **Database:** MongoDB.
- **Search:** MongoDB Search cho full-text/filter; MongoDB Vector Search cho semantic retrieval nếu hạ tầng cho phép.
- **AI:** một LLM API để tóm tắt và trả lời dựa trên dữ liệu truy xuất.
- **Scheduler:** cron job hoặc background worker trong Node.js.
- **MVP connectors:** RSS/Atom, arXiv API, GitHub REST API và Hacker News API.

Các collection MongoDB dự kiến:

```text
users
sessions
sources
articles
savedArticles
ingestionJobs
indexingJobs
chatSessions
takedownRequests
adminAuditLogs
```

Embedding chỉ được tạo từ phần nội dung mà dự án có quyền xử lý. Không dùng vector database như một cách để che giấu việc lưu nội dung không được phép.

## 7. Tiêu chí hoàn thành MVP

MVP được xem là hoàn thành khi:

- Cả bốn connector RSS/Atom, arXiv, GitHub và Hacker News đều hoạt động end-to-end.
- Source Registry có nhiều source definition được bật cho RSS/Atom và GitHub; category/query của arXiv và endpoint của Hacker News có thể cấu hình mà không sửa logic lõi.
- Mỗi nguồn được kích hoạt đều có hồ sơ quyền sử dụng, cấp độ thẩm quyền và chính sách citation.
- Luồng ingest → chuẩn hóa → lưu MongoDB → hiển thị React hoạt động end-to-end.
- Người dùng có thể tìm, lọc và lưu bài.
- AI tạo được tóm tắt ngắn cho nội dung hợp lệ.
- AI trả lời câu hỏi từ dữ liệu truy xuất và cung cấp citation có thể mở được.
- Hệ thống từ chối trả lời khi không có bằng chứng phù hợp.
- Không lưu hoặc hiển thị toàn bộ bài báo có bản quyền khi chưa có quyền sử dụng.
- Có bộ câu hỏi kiểm thử để đánh giá độ đúng của citation, độ bám nguồn và khả năng từ chối.
- Admin đăng nhập được bằng tài khoản được seed; user thông thường bị từ chối tại mọi endpoint admin.
- Admin có thể tạo nguồn hợp lệ, yêu cầu chạy ingestion, xem lỗi, ẩn bài và retry indexing mà không truy cập trực tiếp vào worker hoặc secret.
- Chỉ bài `published` xuất hiện trong feed, search và AI retrieval; bài `review-needed`, `hidden` hoặc `removed` không bị rò rỉ qua bất kỳ bề mặt nào.
- Admin có thể xử lý một yêu cầu gỡ nội dung end-to-end; khi hoàn tất, metadata, summary và embedding thuộc phạm vi được duyệt bị loại bỏ đúng cách.
- Khi admin khóa một user, các session hiện có của user bị vô hiệu hóa và user không thể tiếp tục gọi API cần đăng nhập.
- Mọi thao tác quản trị thay đổi trạng thái đều tạo audit log có actor, target, lý do và kết quả.

Các chỉ số nên theo dõi trong quá trình đánh giá:

- tỷ lệ bài có đầy đủ nguồn và original URL;
- tỷ lệ citation trỏ đúng tài liệu hỗ trợ phát biểu;
- số bản ghi trùng được phát hiện;
- tỷ lệ job ingest thành công;
- thời gian phản hồi của tìm kiếm và AI Q&A;
- số câu trả lời bị từ chối đúng khi thiếu bằng chứng.

## 8. Feature có thể phát triển trong tương lai

### 8.1. Mở rộng nguồn và nền tảng

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

### 8.5. Trải nghiệm nội dung

- Hỗ trợ song ngữ Việt–Anh.
- Chuyển bản tổng hợp thành audio hoặc podcast ngắn.
- PWA hoặc ứng dụng mobile.
- Browser extension để lưu và hỏi về bài đang đọc.
- Chia sẻ collection hoặc bản brief cho nhóm.

### 8.6. Responsible AI nâng cao

- Chấm điểm groundedness và citation coverage tự động.
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
- Connector cho YouTube, X, Facebook và Instagram.
- Thu thập bài đăng từ tài khoản mạng xã hội cá nhân hoặc không được xác minh.
- Vượt paywall, CAPTCHA hoặc đăng nhập của website khác.
- Lưu trữ và phát lại toàn văn bài báo.
- Sao chép hình ảnh, video hoặc logo khi chưa có quyền sử dụng.
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
- luôn ghi tên nguồn, tác giả nếu có và liên kết đến bài gốc;
- citation không tự động thay thế cho giấy phép sử dụng.

Tham khảo [Văn bản hợp nhất Luật Sở hữu trí tuệ, Điều 15](https://congbao.chinhphu.vn/tai-ve-van-ban-so-155-vbhn-vpqh-46214-58977?format=pdf) và giải thích của [Cục Bản quyền tác giả về tác phẩm báo chí](https://cov.gov.vn/quyen-tac-gia-quyen-lien-quan/tac-pham-bao-chi-hien-nay-co-duoc-bao-ho-quyen-tac-gia-khong-neu-co-thi-tac-pham-bao-chi-bao-gom-cac-the-loai-nao-thoi-han-bao-ho-cac-the-loai-tac-pham-bao-chi-do-trong-thoi-gian-bao-lau-168809.html).

### 10.3. Điều khoản API và website là một lớp ràng buộc riêng

Ngay cả khi một cách sử dụng có thể thuộc ngoại lệ của luật bản quyền, dự án vẫn phải kiểm tra điều khoản của API, RSS và website.

Đối với các connector của MVP:

- **RSS/Atom:** feed là một phương thức phân phối dữ liệu, không mặc nhiên là giấy phép tái xuất bản toàn bộ nội dung. Cần tuân theo điều khoản của từng publisher.
- **arXiv:** sử dụng API theo [điều khoản và hướng dẫn của arXiv](https://info.arxiv.org/help/api/index.html), ghi nhận nguồn theo yêu cầu và kiểm tra giấy phép riêng của từng paper trước khi xử lý full text.
- **GitHub:** public release có thể được truy xuất bằng [GitHub Releases API](https://docs.github.com/en/rest/releases/releases), nhưng việc truy cập công khai không tự động cấp quyền tái sử dụng mọi nội dung hoặc asset trong repository.
- **Hacker News:** [API chính thức](https://github.com/HackerNews/API) cung cấp metadata, item và liên kết. Quyền truy cập HN không đồng thời cấp quyền sử dụng bài viết tại website được liên kết.

Các connector mạng xã hội trong tương lai phải dùng API hoặc cơ chế embed chính thức, đồng thời tuân thủ quy định hiển thị, lưu trữ, xóa dữ liệu và attribution của từng nền tảng.

### 10.4. Gửi nội dung đến nhà cung cấp AI

Gửi bài viết đến một LLM API là một hình thức xử lý và truyền dữ liệu cho bên thứ ba. Trước khi thực hiện cần kiểm tra:

- nguồn có cho phép xử lý nội dung theo cách đó hay không;
- nhà cung cấp AI lưu dữ liệu trong bao lâu;
- dữ liệu có được dùng để huấn luyện mô hình hay không;
- khu vực lưu trữ và cơ chế xóa dữ liệu;
- nội dung có chứa dữ liệu cá nhân hoặc thông tin nhạy cảm hay không.

Không gửi toàn văn của nguồn `metadata-only`, `blocked` hoặc `review-needed` đến LLM.

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
- xóa metadata, summary và embedding liên quan;
- lưu yêu cầu gỡ nội dung và kết quả xử lý;
- cập nhật lại index sau khi xóa;
- cung cấp kênh liên hệ cho chủ sở hữu quyền.

### 10.7. Chế độ triển khai đồ án

Phiên bản đầu nên được triển khai theo một trong các hình thức:

- chạy local khi demo;
- website có tài khoản và giới hạn người truy cập;
- deployment tạm thời phục vụ chấm đồ án.

Trước khi mở công khai cho mọi người hoặc thêm quảng cáo, affiliate, subscription hay khách hàng doanh nghiệp, phải đánh giá lại toàn bộ nguồn và quyền sử dụng.

## 11. Rủi ro chính

| Rủi ro | Cách giảm thiểu ban đầu |
|---|---|
| Vi phạm bản quyền hoặc điều khoản nguồn | Source allowlist, lưu trạng thái giấy phép, không lưu full text mặc định |
| AI hallucination | RAG, citation, từ chối khi thiếu bằng chứng, bộ kiểm thử groundedness |
| Prompt injection từ bài viết | Coi nội dung nguồn là dữ liệu, tách system instruction, lọc và giới hạn tool |
| Tin trùng | Canonical URL, hash và semantic similarity |
| Tin cũ hoặc sai thời điểm | Hiển thị `publishedAt`, `retrievedAt` và phạm vi thời gian truy vấn |
| Chi phí LLM | Cache summary, giới hạn độ dài input, batch job và quota người dùng |
| API thay đổi hoặc hết quota | Adapter riêng cho từng nguồn, retry giới hạn và khả năng tắt nguồn |
| Nội dung cộng đồng bị nhầm là thông tin đã xác thực | Gắn Hacker News là `community-signal`; yêu cầu nguồn primary hoặc editorial xác nhận |
| Bản tóm tắt thay thế bài gốc | Tóm tắt ngắn, không dùng ảnh/toàn văn, nút đọc nguồn nổi bật |
| User chiếm quyền hoặc gọi trực tiếp admin API | Kiểm tra role tại backend, session an toàn, CSRF protection, rate limiting và test `401/403` |
| Source URL độc hại truy cập mạng nội bộ | Validate URL/host, chặn private IP và redirect không an toàn trước khi worker fetch |
| Bài chưa duyệt hoặc đã ẩn vẫn còn trong AI index | Chỉ index trạng thái `published`, đồng bộ article/index và kiểm thử các invariant trạng thái |
| Admin thao tác nhầm hoặc khó truy vết | Ưu tiên soft delete, yêu cầu xác nhận/lý do và ghi audit log theo kiểu append-only ở tầng ứng dụng |

## 12. Câu hỏi còn mở

- Thời gian và số thành viên thực hiện dự án là bao nhiêu?
- Giảng viên yêu cầu deployment công khai hay chỉ cần demo?
- Nguồn nào có giấy phép đủ rõ để dùng phần nội dung dài hơn metadata?
- MVP sẽ bật bao nhiêu RSS/Atom feed, arXiv category/query và GitHub repository trong bản demo?
- LLM API và ngân sách sử dụng dự kiến là gì?
- MongoDB Atlas Search/Vector Search có nằm trong hạ tầng cho phép không?
- Citation cần ở cấp bài, cấp đoạn hay cấp từng phát biểu?
- Có cần hỗ trợ tiếng Việt ngay trong MVP hay chỉ tiếng Anh?
- Mức độ tự động của việc kiểm tra và duyệt nguồn là bao nhiêu?

## 13. Quyết định hiện tại

- **Go** với ý tưởng TechPulse AI.
- Ưu tiên một MVP nhỏ, có nguồn rõ ràng và luồng AI có citation.
- Chốt bốn nhóm nguồn cho MVP: RSS/Atom, arXiv, GitHub và Hacker News.
- YouTube, X, Facebook, Instagram và các nền tảng khác được chuyển sang giai đoạn hoàn thiện sau MVP.
- Số lượng source definition có thể tăng qua Source Registry mà không cần thêm connector mới.
- MVP có hai role người dùng `user` và `admin`; `system-worker` là actor nội bộ, không phải tài khoản đăng nhập.
- Admin dùng authentication backend chung, giao diện `/admin` riêng và server-side session; role luôn được kiểm tra ở backend.
- Admin đầu tiên được tạo bằng seed script; không cho đăng ký hoặc tự nâng role admin qua UI/API.
- Pipeline tự xuất bản bản ghi hợp lệ; admin chỉ xử lý cấu hình, lỗi và các bản ghi `review-needed`, không duyệt từng bài trong luồng bình thường.
- Mọi thao tác quản trị thay đổi trạng thái phải có audit log; chỉ bài `published` được xuất hiện trong feed, search và AI retrieval.
- Xem quản trị nguồn và responsible AI là năng lực cốt lõi của sản phẩm.
- Không xây sản phẩm dựa trên việc “lách luật” hoặc giả định rằng phi thương mại đồng nghĩa với được phép sử dụng mọi nội dung.
- Chưa chuyển tài liệu này thành PRD hoặc đặc tả triển khai cho đến khi chốt phạm vi nguồn, thời gian và quy mô nhóm.
