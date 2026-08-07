# TechPulse AI — Product Brief

> Trạng thái: Product direction đã được chấp thuận  
> Cập nhật: 08/08/2026  
> Nguồn quyết định: [TechPulse-AI.md](./TechPulse-AI.md)  
> Bước tiếp theo: [PRD.md](./PRD.md)

## 1. Kết luận product-lens

**Khuyến nghị: GO, với phạm vi MVP được khóa trong 4 tuần.**

TechPulse AI có một vấn đề đủ rõ để làm đồ án: người đọc công nghệ phải theo dõi nhiều nguồn, khó loại tin trùng và khó kiểm chứng câu trả lời AI. Điểm chứng minh giá trị không phải số lượng nguồn mà là một luồng hoàn chỉnh từ nguồn đã duyệt đến summary tiếng Việt và AI Q&A có citation.

Rủi ro lớn nhất không phải kỹ thuật giao diện mà là:

1. phạm vi nguồn và quyền xử lý không được thực thi nhất quán;
2. citation tồn tại nhưng không thực sự hỗ trợ phát biểu;
3. phạm vi 4 tuần bị mở rộng bởi crawler, social connector hoặc search infrastructure quá lớn;
4. người dùng không thấy giá trị quay lại sau lần demo đầu tiên.

## 2. Product diagnostic

### 2.1. Sản phẩm dành cho ai?

Người dùng chính của MVP là:

- sinh viên CNTT Việt Nam;
- junior/mid-level developer đọc nội dung tiếng Anh nhưng muốn nắm nhanh bằng tiếng Việt;
- người theo dõi AI, AI Agent, Robotics và Software Engineering vài lần mỗi tuần;
- người muốn kiểm chứng nguồn thay vì chỉ nhận câu trả lời từ chatbot tổng quát.

MVP không tối ưu cho nhà báo chuyên nghiệp, nhà nghiên cứu cần systematic review hoặc doanh nghiệp cần market intelligence theo thời gian thực.

### 2.2. Vấn đề cần giải quyết

- Nội dung công nghệ nằm rải rác ở báo chí, blog, nguồn nghiên cứu và cộng đồng.
- Cùng một sự kiện được đăng lại nhiều lần, gây nhiễu.
- Người đọc phải tự dịch, tự so sánh và tự đánh giá độ tin cậy.
- Chatbot tổng quát có thể trả lời không bám vào dữ liệu mới hoặc không chỉ ra bằng chứng.
- News aggregator thông thường chủ yếu đưa link, chưa giúp tổng hợp câu hỏi đa nguồn bằng tiếng Việt.

### 2.3. Tại sao là lúc này?

- Tốc độ xuất bản nội dung AI/Agent tăng nhanh, làm chi phí theo dõi thủ công cao hơn.
- RSS/Atom, arXiv và Hacker News cung cấp access path đủ rõ cho một MVP có kiểm soát.
- LLM và embedding API chi phí thấp giúp một đồ án nhỏ triển khai summary, dịch và retrieval.
- Citation-aware RAG cho phép biến “AI biết nhiều” thành “AI chỉ trả lời từ nguồn đã truy xuất”.

### 2.4. Phiên bản 10-star

Nếu không bị giới hạn thời gian/ngân sách, sản phẩm có thể:

- gom nhiều bài thành event cluster và timeline;
- citation tới từng claim;
- so sánh nguồn mâu thuẫn;
- theo dõi correction và thay đổi theo thời gian;
- cá nhân hóa feed/digest;
- hỗ trợ nhiều ngôn ngữ output;
- mở rộng GitHub, YouTube và social platform chính thức;
- cung cấp workspace và báo cáo cho nhóm kỹ thuật.

Đây là định hướng hậu MVP, không phải cam kết cho đồ án.

### 2.5. MVP nhỏ nhất chứng minh luận điểm

MVP phải chứng minh được chuỗi giá trị:

```text
Nguồn đã duyệt
→ ingestion có log và chống trùng
→ feed/search
→ summary tiếng Việt
→ semantic/keyword retrieval
→ Q&A có citation
→ mở nguồn gốc để kiểm chứng
```

Phạm vi cố định:

- 3 connector: RSS/Atom, arXiv, Hacker News;
- khoảng 250–400 bài;
- JavaScript/JSX cho React và JavaScript cho Node.js/Express;
- UI, summary và Q&A bằng tiếng Việt;
- citation cấp bài và cấp đoạn;
- ảnh đại diện chỉ remote-preview khi Source Registry cho phép, nếu không dùng visual fallback do TechPulse sở hữu; video quan trọng chỉ dẫn link tới nguồn và ghi rõ AI chưa phân tích video;
- user/admin authentication;
- Source Registry và admin operations;
- Vercel Hobby + MongoDB Atlas;
- MongoDB text search và BGE-M3/cosine retrieval.

### 2.6. Anti-goals

- Không crawl toàn Internet.
- Không lưu hoặc dịch toàn văn bài báo.
- Không tải về, cache hoặc rehost binary ảnh/video của nguồn; không phân tích ảnh/video bằng AI trong MVP.
- Không vượt paywall/CAPTCHA/login.
- Không triển khai GitHub/social connector trong MVP.
- Không xây mạng xã hội, comment system hoặc payment.
- Không fine-tune model trên dữ liệu báo chí.
- Không cam kết AI luôn đúng.
- Không dùng số lượng nguồn làm thước đo thành công chính.

### 2.7. Dấu hiệu sản phẩm hoạt động

#### Product outcome

- Người thử nghiệm hoàn thành được luồng tìm một chủ đề → đọc summary → mở citation mà không cần hướng dẫn.
- Người thử nghiệm đánh giá summary giúp quyết định bài nào đáng đọc.
- Có tín hiệu quay lại hoặc mong muốn dùng digest/feed thay vì chỉ thử chatbot một lần.

#### Quality metrics

- 100% article card có source và original URL hợp lệ.
- Citation precision trong bộ test đạt tối thiểu 90% ở cấp bài/đoạn.
- Không có câu trả lời “có vẻ đúng” nhưng không có source supporting trong context.
- Hệ thống từ chối đúng phần lớn câu hỏi ngoài dữ liệu kiểm thử.
- Bài `hidden`, `removed` hoặc `review-needed` không xuất hiện trong retrieval.

#### Operational metrics

- Ingestion success rate mục tiêu từ 95% trở lên trong demo dataset.
- Chạy lặp cùng ingestion job không tạo duplicate.
- Search vẫn hoạt động khi embedding provider lỗi.
- Mọi admin mutation có audit record.

Các ngưỡng trên là tiêu chí đánh giá đồ án, không phải số liệu product-market fit đã được chứng minh.

## 3. Giả thuyết cần kiểm chứng

| Giả thuyết | Cách kiểm chứng trong 4 tuần | Tín hiệu đạt |
|---|---|---|
| Summary tiếng Việt làm giảm thời gian chọn bài | Cho 3–5 người thử feed và phỏng vấn ngắn | Đa số chọn được bài muốn đọc trong vài phút |
| Citation tạo niềm tin hơn chatbot thông thường | So sánh một câu trả lời có/không citation | Người thử biết cách mở và đối chiếu nguồn |
| Ba connector đủ tạo cảm giác đa dạng | Seed 8–10 RSS, 3 arXiv query và HN | Feed không bị một nguồn/chủ đề chi phối |
| Search + Q&A giải quyết nhu cầu khác feed | Cho người thử hoàn thành task theo chủ đề/thời gian | Tìm được câu trả lời và nguồn hỗ trợ |
| Source governance có thể demo mà không gây cản trở | Thực hiện onboarding ít nhất 3 loại source | Admin hiểu vì sao nguồn được permitted/metadata-only |

## 4. Ưu tiên feature

### P0 — bắt buộc để chứng minh thesis

- Source Registry và policy enforcement;
- ingestion RSS/arXiv/HN;
- normalization, deduplication và job log;
- feed, filter, text search và detail page;
- ảnh preview có kiểm soát, visual fallback và link nguồn cho video quan trọng;
- summary tiếng Việt;
- AI Q&A với citation;
- authentication, admin operations và audit;
- Vercel deployment với demo dataset.

### P1 — chỉ làm sau P0 ổn định

- embedding/cosine retrieval nếu text retrieval đã hoạt động;
- saved articles và topic preference;
- streaming Q&A;
- review queue và takedown flow hoàn chỉnh.

### P2 — hậu MVP

- GitHub/social/video connector và official video embed;
- transcript, image understanding hoặc video understanding bằng AI;
- event clustering/timeline;
- claim-level citation;
- English UI/output;
- personalization nâng cao;
- Atlas Vector Search hoặc search service riêng.

## 5. Product risks và quyết định

| Risk | Quyết định hiện tại |
|---|---|
| Product trở thành RSS reader có chatbot gắn thêm | Q&A chỉ dùng retrieved evidence và citation là acceptance gate |
| Summary thay thế bài gốc | Summary ngắn, không toàn văn; media chỉ để định hướng và CTA nguồn luôn nổi bật |
| Ảnh/video công khai bị hiểu nhầm là được tự do sao chép | Media policy độc lập theo source; remote-preview/link-only, không rehost, có attribution và fallback |
| URL ảnh nguồn hỏng hoặc bị chặn hotlink | Lazy-load, error fallback do TechPulse sở hữu; không proxy tùy ý qua backend |
| Nguồn nhiều nhưng chất lượng thấp | Authority tier và allowlist; HN chỉ là community signal |
| License không rõ | Mặc định `metadata-only`; admin phê duyệt scope |
| Scope vượt 4 tuần | Khóa ba connector; mọi social/GitHub chuyển P2 |
| Free AI provider không ổn định | Provider abstraction, fallback trả phí thấp và text-search fallback |

## 6. Handoff

Product direction đã được cụ thể hóa trong [PRD.md](./PRD.md) và bộ architecture/contract/blueprint ở [README.md](./README.md). Implementation không cần thêm discovery lớn trước Step 1; chỉ cần hoàn thiện allowlist RSS và media policy/evidence cụ thể trong lúc seed nguồn.
