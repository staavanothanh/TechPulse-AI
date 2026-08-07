# AgoraLLM — Ý tưởng và định hướng đồ án

> **Tên đề tài:** Xây dựng nền tảng web thảo luận đa mô hình AI theo cơ chế Bring Your Own Key (BYOK)
>
> **Tên sản phẩm:** AgoraLLM — Secure Multi-LLM Discussion Workspace
>
> **Phán quyết:** GO — Nên chốt và triển khai với phạm vi MVP được giới hạn rõ ràng.

## 1. Tổng quan ý tưởng

AgoraLLM là một ứng dụng web Full-Stack cho phép người dùng đăng ký hoặc đăng nhập, kết nối các nhà cung cấp mô hình ngôn ngữ lớn bằng API key cá nhân, tạo các cuộc trò chuyện và sử dụng nhiều LLM trong cùng một giao diện.

Người dùng có thể:

- Gọi một model cụ thể bằng cú pháp `@model`.
- Gọi đồng thời nhiều model bằng `@all` để so sánh câu trả lời.
- Khởi chạy chế độ thảo luận có kiểm soát để các model đưa ra quan điểm, phản biện và tổng hợp kết luận.
- Lưu, tải lại và xóa lịch sử trò chuyện.
- Quản lý, kiểm tra, thay thế hoặc ngắt kết nối provider.

Sản phẩm vẫn là **ứng dụng chat đa provider** như ý tưởng ban đầu. Điểm khác biệt không nằm ở việc hỗ trợ thật nhiều provider, mà nằm ở cách hệ thống tổ chức nhiều model trong cùng một cuộc trò chuyện và bảo vệ credential của người dùng.

### Mô tả ngắn cho báo cáo

> AgoraLLM là nền tảng chat đa provider theo mô hình BYOK, cung cấp ba chế độ tương tác: gọi trực tiếp một model, so sánh song song nhiều model và thảo luận phản biện có kiểm soát. Hệ thống tập trung vào kiến trúc adapter, streaming, điều phối nhiều provider, bảo mật API key và phân quyền lịch sử hội thoại.

## 2. Sự phù hợp với các học phần

| Học phần | Nội dung thể hiện trong dự án |
|---|---|
| Lập trình cơ sở với C | Tư duy thuật toán, cấu trúc điều khiển, xử lý trạng thái và luồng dữ liệu; không nên thêm module C nhân tạo chỉ để đủ danh sách môn nếu rubric không yêu cầu. |
| HTML, CSS, JavaScript | Landing page, form, layout responsive, chat composer, trạng thái loading/error/empty và xử lý tương tác. |
| React và AI | Chat interface, provider settings, model cards, mention menu, SSE event consumer và quản lý state nhiều response. |
| SQL Server và NoSQL | Thiết kế dữ liệu, indexing, quan hệ sở hữu và lựa chọn MongoDB Atlas cho conversation/message có cấu trúc linh hoạt. Nếu rubric bắt buộc cả SQL Server, có thể cân nhắc kiến trúc hybrid sau khi MVP ổn định. |
| Node.js và AI | API gateway, authentication, provider adapters, parser `@mention`, fan-out request, streaming, error isolation và discussion orchestration. |
| Project AI-Powered Website | Tích hợp Full-Stack hoàn chỉnh, triển khai thật, kiểm thử, bảo mật và trình diễn sản phẩm. |

Không nên dùng hai database hoặc viết thêm chương trình C chỉ để tạo cảm giác tích hợp nhiều công nghệ. Việc đó chỉ nên thực hiện khi yêu cầu đánh giá của môn học bắt buộc.

## 3. Ba chế độ tương tác cốt lõi

### 3.1. Direct Mode — gọi một model

```text
@gemini Hãy phân tích ưu và nhược điểm của MongoDB.
```

Chỉ model được mention nhận request.

### 3.2. Compare Mode — gọi song song nhiều model

```text
@all Hãy đề xuất kiến trúc cho hệ thống đặt vé.
```

Các model được gọi song song và trả lời độc lập. Frontend hiển thị mỗi câu trả lời trong một card riêng, kèm trạng thái, latency hoặc usage nếu có.

`@all` có nghĩa là **so sánh các câu trả lời độc lập**, không tự động biến thành cuộc tranh luận nhiều vòng.

### 3.3. Discussion Mode — thảo luận có kiểm soát

```text
/discuss Có nên sử dụng microservices cho một startup mới?
```

Quy trình đề xuất:

```text
Chủ đề của người dùng
        ↓
Các model đưa ra quan điểm độc lập
        ↓
Các model phản biện một số quan điểm khác
        ↓
Model moderator tổng hợp
        ↓
Điểm đồng thuận, điểm bất đồng, trade-off và khuyến nghị
```

Discussion Mode là tính năng tạo dấu ấn cho sản phẩm. Nó phải có giới hạn rõ ràng về số model, số vòng, số token và thời gian chạy; không được triển khai thành vòng lặp tự động vô hạn.

## 4. Phạm vi MVP đề xuất

### Bắt buộc

- React frontend.
- Node.js/Express backend.
- MongoDB Atlas.
- Đăng ký, đăng nhập, logout bằng email/password.
- Google OAuth cho đăng nhập vào chính AgoraLLM.
- Session cookie với các thuộc tính bảo mật phù hợp.
- Kết nối provider bằng API key.
- Kiểm tra API key trước khi lưu.
- Mã hóa API key bằng AES-256-GCM.
- Không trả raw API key về frontend.
- Quản lý, thay thế và xóa provider connection.
- Ít nhất hai provider thực tế được kiểm thử end-to-end.
- `GeminiAdapter`.
- `OpenAICompatibleAdapter` cho OpenAI, DeepSeek hoặc provider tương thích đã được kiểm thử.
- Tạo, đổi tên, tải và xóa conversation.
- Lưu lịch sử message.
- Gọi một model bằng `@model`.
- Gọi nhiều model bằng `@all`.
- Hiển thị response card riêng cho từng model.
- Trạng thái loading, completed và failed riêng cho từng provider.
- SSE cho streaming một model.
- Discussion Mode giới hạn ở khoảng hai model, tối đa hai vòng và một lần tổng hợp.
- Rate limit, timeout, cancellation và giới hạn token/call cơ bản.
- HTTPS deployment.
- Kiểm tra ownership để ngăn truy cập conversation của người dùng khác.

### Có thể bổ sung sau khi MVP ổn định

- GitHub OAuth.
- `AnthropicAdapter`.
- Multiplex streaming hoàn chỉnh cho `@all`.
- Token usage và latency theo provider.
- Retry có giới hạn cho lỗi tạm thời.
- Audit log cho thao tác credential.
- Moderator có thể lựa chọn model.
- Preset role như Analyst, Critic và Moderator.
- Export conversation ra Markdown.
- Ước tính số API call trước khi chạy Discussion Mode.
- Domain allowlist cho custom OpenAI-compatible endpoint.

### Không nên đưa vào phiên bản đầu

- RAG và upload tài liệu.
- Voice chat.
- Tạo ảnh, âm thanh hoặc video.
- Thanh toán.
- Mobile app.
- Public multi-user collaboration.
- Prompt marketplace.
- Agent có quyền chạy code hoặc gọi tool.
- Provider OAuth chưa được xác minh rõ ràng.
- Custom endpoint tùy ý mà chưa có bảo vệ SSRF đầy đủ.
- Vòng thảo luận không giới hạn.
- Sáu integration độc lập ngay từ đầu.

## 5. Chính sách authentication

Cần phân biệt rõ hai loại authentication.

### Authentication của website

Dùng để đăng nhập vào AgoraLLM:

- Email/password.
- Google OAuth.
- GitHub OAuth nếu có đủ thời gian.

### Authentication của provider inference

Dùng để gọi API của LLM:

- OpenAI: API key.
- Anthropic: API key.
- DeepSeek: API key.
- Kimi: API key.
- Gemini: API key trong MVP; OAuth inference chỉ là hướng mở rộng sau khi kiểm tra flow chính thức.
- Custom endpoint: credential tùy theo endpoint, nhưng endpoint phải bị giới hạn và kiểm tra an toàn.

Không nên hứa hẹn tính năng “đăng nhập OpenAI/Claude để dùng quota ChatGPT/Claude” vì subscription của sản phẩm chat và quyền gọi API thường là hai hệ thống khác nhau.

## 6. Kiến trúc provider

Nên dùng Adapter hoặc Strategy pattern để controller không phụ thuộc trực tiếp vào format riêng của từng provider.

```ts
interface LLMProviderAdapter {
  validateCredential(
    connection: ProviderConnection
  ): Promise<boolean>;

  listModels(
    connection: ProviderConnection
  ): Promise<ModelInfo[]>;

  streamResponse(input: {
    connection: ProviderConnection;
    model: string;
    messages: ChatMessage[];
    signal?: AbortSignal;
  }): AsyncIterable<string>;
}
```

Cấu trúc ban đầu:

```text
LLMProviderAdapter
├── GeminiAdapter
├── OpenAICompatibleAdapter
└── AnthropicAdapter       # mục tiêu mở rộng
```

`OpenAICompatibleAdapter` có thể tái sử dụng cho nhiều preset, nhưng chỉ nên quảng bá provider nào đã được kiểm thử thực tế.

### Luồng xử lý một request

```text
React
  → AgoraLLM backend
  → xác thực user và kiểm tra ownership
  → parse @mention hoặc mode
  → lấy encrypted credential
  → decrypt trong memory
  → gọi adapter tương ứng
  → chuẩn hóa response/event
  → lưu message và usage
  → stream kết quả về React
```

React không được gọi trực tiếp LLM provider bằng API key của người dùng.

## 7. Điều phối nhiều model

Với `@all`, các request nên chạy song song nhưng phải xử lý lỗi độc lập.

- Request không streaming: dùng `Promise.allSettled` thay vì `Promise.all`.
- Mỗi model run có trạng thái riêng.
- Một provider lỗi không được làm mất response thành công của provider khác.
- Mỗi request cần timeout và có thể bị hủy bằng `AbortController`.
- Không retry vô hạn.
- Không retry authentication error.
- Giới hạn số model được gọi trong một lần.

Ví dụ trạng thái UI:

```text
Gemini       completed
DeepSeek     failed: quota exceeded
OpenAI       streaming
```

### SSE event đề xuất

```json
{
  "runId": "run_123",
  "provider": "gemini",
  "model": "gemini-model",
  "type": "delta",
  "content": "..."
}
```

Các event chính:

```text
run_started
delta
completed
failed
usage
```

Frontend dùng `runId` để đưa chunk vào đúng response card.

## 8. Discussion Mode và kiểm soát chi phí

Discussion Mode có thể nhân số lần gọi API rất nhanh. Với bốn model, ba vòng và một moderator, số lần gọi tối thiểu có thể là:

```text
4 × 3 + 1 = 13 API calls
```

Ngoài số request, các vòng sau còn truyền output của các model vào context mới nên token input cũng tăng.

MVP nên có cấu hình giới hạn tương tự:

```ts
interface DiscussionLimits {
  maxParticipants: number;
  maxRounds: number;
  maxOutputTokensPerTurn: number;
  maxTotalTokens: number;
  timeoutSeconds: number;
}
```

UI nên cho người dùng biết trước:

- Có bao nhiêu model tham gia.
- Có bao nhiêu vòng.
- Ước tính số API call.
- Provider nào có thể phát sinh chi phí.
- Discussion có thể bị giới hạn hoặc dừng khi vượt quota.

BYOK giúp chủ dự án không phải trả toàn bộ chi phí inference, nhưng không loại bỏ nhu cầu rate limit, quota control và abuse prevention.

## 9. Bảo mật API key

Đây là phần cần được ưu tiên số một và cũng là nội dung có thể tạo điểm cộng khi bảo vệ.

### Thiết kế đề xuất

- Mã hóa bằng AES-256-GCM trước khi insert vào MongoDB.
- Mỗi credential có ciphertext, IV/nonce, authentication tag và key version.
- Master encryption key nằm trong environment variable hoặc secret manager.
- Không lưu master key trong MongoDB.
- Chỉ decrypt trong backend memory khi cần gọi provider.
- Không log key, request headers, bearer token hoặc object chứa credential.
- Không lưu key trong React hoặc `localStorage`.
- Không trả raw key qua API response.
- Chỉ trả masked key, ví dụ `sk-••••••4Hd9`.
- Cho phép user revoke, thay thế hoặc xóa credential.
- Xóa credential đã mã hóa khi user disconnect provider.
- Dùng HTTPS cho frontend/backend và backend/provider.

### Vì sao dùng GCM thay vì CBC?

AES-256-CBC chỉ cung cấp confidentiality nếu được dùng đúng cách; cần thêm cơ chế integrity riêng. AES-256-GCM cung cấp authenticated encryption với authentication tag, phù hợp hơn cho thiết kế mới và giúp phát hiện ciphertext bị sửa.

### Giới hạn cần nói trung thực

Application-level encryption bảo vệ tốt hơn trước việc database bị đọc trái phép, nhưng không phải bảo vệ tuyệt đối. Nếu attacker chiếm được toàn bộ backend cùng master key, server có thể giải mã credential trong lúc sử dụng. Phiên bản production nâng cao có thể dùng KMS, envelope encryption hoặc MongoDB Client-Side Field Level Encryption.

## 10. Bảo mật tài khoản và lịch sử chat

- Password phải hash bằng Argon2id hoặc bcrypt, không dùng encryption reversible.
- Session cookie nên có `HttpOnly`, `Secure` và `SameSite` phù hợp.
- Bật CSRF protection nếu dùng cookie authentication.
- Mọi truy vấn conversation phải lọc theo `ownerId` lấy từ session.
- Không nhận `userId` tùy ý từ frontend để quyết định quyền sở hữu.
- Kiểm tra cả authentication và resource ownership.
- Không đưa prompt hoặc completion đầy đủ vào application log.
- Có chức năng xóa lịch sử.
- Có thể giới hạn độ dài prompt, message và conversation.
- Sanitize Markdown/HTML trước khi render output của model.
- Không dùng `dangerouslySetInnerHTML` trực tiếp với nội dung chưa được kiểm soát.
- Không tuyên bố hệ thống có end-to-end encryption: backend và provider phải đọc prompt để xử lý.

Mô hình kiểm tra ownership đúng:

```text
conversationId = requestedId
AND ownerId = authenticatedUserId
```

## 11. Rủi ro custom endpoint và SSRF

Cho phép người dùng nhập URL tùy ý để backend gọi provider có thể tạo SSRF. Một attacker có thể yêu cầu server gọi vào:

```text
http://127.0.0.1:27017
http://localhost:3000/admin
http://169.254.169.254/
http://10.0.0.5/internal
```

Nếu triển khai custom endpoint, cần tối thiểu:

- Chỉ cho phép HTTPS.
- Chặn localhost, loopback, private IP, link-local, reserved IP và cloud metadata address.
- Resolve DNS rồi kiểm tra IP thực tế.
- Kiểm tra lại sau redirect hoặc tắt follow redirect.
- Có timeout và giới hạn response size.
- Không cho phép arbitrary user-controlled HTTP headers.
- Không đặt secret trong URL.
- Ưu tiên domain allowlist trong MVP.
- Chỉ hỗ trợ format OpenAI-compatible.

Nếu chưa triển khai đầy đủ các kiểm soát này, custom endpoint tùy ý phải để ngoài MVP.

## 12. Mô hình dữ liệu MVP

Năm collection là đủ cho phiên bản đầu:

```text
users
  ├── _id
  ├── email
  ├── passwordHash
  ├── displayName
  └── authAccounts

providerConnections
  ├── userId
  ├── providerType
  ├── displayName
  ├── baseUrl
  ├── encryptedCredential
  ├── maskedCredential
  ├── selectedModels
  ├── status
  └── lastVerifiedAt

conversations
  ├── ownerId
  ├── title
  ├── mode
  ├── selectedModels
  └── timestamps

messages
  ├── conversationId
  ├── ownerId
  ├── role
  ├── content
  ├── mentions
  ├── replyTo
  └── createdAt

modelRuns
  ├── conversationId
  ├── sourceMessageId
  ├── responseMessageId
  ├── provider
  ├── model
  ├── phase
  ├── status
  ├── latencyMs
  ├── inputTokens
  ├── outputTokens
  ├── errorCode
  └── createdAt
```

Index nên có:

```text
messages:            { conversationId: 1, createdAt: 1 }
conversations:       { ownerId: 1, updatedAt: -1 }
providerConnections: { userId: 1, providerType: 1 }
modelRuns:           { sourceMessageId: 1, provider: 1, model: 1 }
```

## 13. Các điểm mạnh

### Về kỹ thuật

- Bao phủ frontend, backend, database, authentication, external API và deployment.
- Có bài toán backend thực sự thay vì chỉ CRUD.
- Thể hiện Adapter/Strategy, streaming, fan-out request và orchestration.
- Có thể xử lý failure isolation giữa nhiều provider.
- Có dữ liệu linh hoạt phù hợp với MongoDB.

### Về sản phẩm

- Nhu cầu sử dụng dễ hiểu.
- Demo trực quan và có tính thuyết phục.
- User có thể tự dùng credential của mình, giảm chi phí inference cho người xây dựng.
- Có thể mở rộng provider mà không thay đổi toàn bộ hệ thống.
- Discussion Mode tạo điểm nhận diện cao hơn một chatbot thông thường.

### Về bảo vệ đồ án

- Có nhiều vấn đề để giải thích: encryption, authentication, authorization, SSRF, rate limit, cost control và error handling.
- Có thể chứng minh hệ thống không chỉ chạy ở happy path.
- Dễ đưa ra các tiêu chí hoàn thành có thể kiểm thử.

## 14. Các điểm yếu

- Phạm vi rất dễ bị mở rộng quá mức.
- Multi-provider chat không phải ý tưởng hoàn toàn mới; không nên tuyên bố tính mới tuyệt đối.
- API key custody tạo trách nhiệm bảo mật cao.
- Phụ thuộc quota, format, latency và availability của provider bên ngoài.
- Multi-provider streaming phức tạp hơn nhiều so với streaming một provider.
- Discussion Mode có thể chậm, đắt và tạo output dài.
- Provider API có thể thay đổi.
- Nếu không giới hạn context, chi phí token tăng nhanh.
- Học phần C và SQL Server có thể không được thể hiện trực tiếp nếu rubric yêu cầu bắt buộc.
- Custom endpoint có thể trở thành lỗ hổng SSRF nghiêm trọng.
- “AI tranh luận” sẽ trở thành gimmick nếu không hiển thị rõ điểm đồng thuận, bất đồng và trade-off.

## 15. Rủi ro và biện pháp giảm thiểu

| Rủi ro | Mức độ | Biện pháp |
|---|---:|---|
| Lộ API key | Rất cao | AES-256-GCM, master key ngoài DB, không log, không trả raw key, HTTPS. |
| User xem history của user khác | Cao | Luôn lọc theo authenticated owner, test IDOR, không tin `userId` từ frontend. |
| SSRF qua custom endpoint | Cao | MVP dùng domain allowlist hoặc tắt tính năng; validate DNS/IP/redirect. |
| Chi phí tăng do `@all`/discussion | Cao | BYOK, rate limit, max participants, max rounds, token cap, timeout, usage display. |
| Một provider lỗi làm hỏng cả request | Trung bình | `Promise.allSettled`, trạng thái riêng và error boundary riêng. |
| Stream bị ngắt | Trung bình | Event state machine, timeout, abort, lưu trạng thái failed/partial. |
| XSS từ Markdown/model output | Cao | Sanitize HTML, giới hạn URL scheme, không render raw HTML. |
| Session bị đánh cắp/CSRF | Cao | HttpOnly/Secure/SameSite cookie, CSRF protection, logout và rotation. |
| Discussion chạy vô hạn | Cao | Giới hạn vòng, call, token và timeout ở backend. |
| Provider API thay đổi | Trung bình | Adapter boundary, contract test, versioned provider config. |
| Scope không hoàn thành | Rất cao | Chốt P0 trước, vertical slice, không mở rộng trước khi MVP deploy được. |

## 16. Tiêu chí hoàn thành đồ án

Một user mới phải thực hiện được hành trình sau:

1. Đăng ký hoặc đăng nhập bằng Google.
2. Kết nối ít nhất hai provider.
3. Xác nhận rằng raw API key không thể đọc lại từ frontend.
4. Tạo một conversation.
5. Gọi một model bằng `@model`.
6. Gọi nhiều model bằng `@all`.
7. Nhìn thấy trạng thái riêng của từng model.
8. Khởi chạy Discussion Mode có phản biện và tổng hợp.
9. Đóng trình duyệt, đăng nhập lại và xem lịch sử.
10. Xóa conversation.
11. Disconnect provider mà không làm lộ key.
12. User A không thể đọc conversation hoặc connection của user B.
13. Một provider lỗi không làm mất response của provider khác.
14. Website hoạt động qua deployment HTTPS thật.

## 17. Câu hỏi hội đồng cần chuẩn bị

- Vì sao chọn MongoDB thay vì chỉ dùng SQL Server?
- Vì sao frontend không gọi trực tiếp LLM provider?
- API key được mã hóa và quản lý như thế nào?
- Hash khác encryption như thế nào?
- Nếu database bị lộ, attacker lấy được gì?
- Nếu backend và master key cùng bị chiếm thì sao?
- Làm thế nào ngăn IDOR trong lịch sử chat?
- Vì sao dùng SSE thay vì WebSocket?
- `@all` được chạy song song như thế nào?
- Nếu một provider lỗi thì response của các provider khác xử lý ra sao?
- Làm thế nào giới hạn chi phí và vòng thảo luận?
- Nhiều model đồng thuận có đồng nghĩa với câu trả lời đúng không?
- Custom endpoint có nguy cơ SSRF như thế nào?
- OAuth đăng nhập website khác gì OAuth dùng để gọi provider?
- Hệ thống có end-to-end encryption không?
- Điểm khác biệt của AgoraLLM so với LibreChat, TypingMind hoặc các sản phẩm tương tự là gì?
- Nếu provider thay đổi format API thì kiến trúc xử lý thế nào?
- Dự án thể hiện kiến thức C và SQL Server ở đâu?

### Câu trả lời quan trọng về tính mới

> Multi-provider chat không phải khái niệm hoàn toàn mới. Đóng góp của đồ án là thiết kế và triển khai một hệ thống BYOK an toàn với ba chế độ tương tác: gọi trực tiếp, so sánh song song và thảo luận phản biện có kiểm soát. Trọng tâm kỹ thuật nằm ở provider abstraction, streaming, failure isolation, orchestration, authorization và credential security.

### Câu trả lời quan trọng về độ tin cậy của thảo luận

> Hệ thống không coi sự đồng thuận của nhiều model là bằng chứng chắc chắn. Discussion Mode chỉ hỗ trợ khám phá nhiều góc nhìn, phát hiện điểm bất đồng và trình bày trade-off. Người dùng vẫn phải tự đánh giá kết quả, đặc biệt với thông tin chuyên môn hoặc cần cập nhật.

## 18. Lộ trình triển khai khuyến nghị

Nên phát triển theo vertical slice để luôn có luồng chạy được:

### Slice 1 — Nền tảng

```text
Register/login
→ tạo conversation
→ tạo message mẫu
→ lưu MongoDB
→ React hiển thị history
```

### Slice 2 — Một provider thật

```text
Nhập API key
→ validate
→ encrypt
→ lưu
→ gọi provider
→ stream về React
```

### Slice 3 — Adapter và mention

```text
Thêm adapter thứ hai
→ parse @model
→ normalize response
→ lưu model run
```

### Slice 4 — Compare Mode

```text
@all
→ gọi song song
→ xử lý lỗi độc lập
→ hiển thị card riêng
```

### Slice 5 — Discussion Mode

```text
/discuss
→ hai vòng có giới hạn
→ moderator summary
→ usage tracking
```

### Slice 6 — Hardening và demo

```text
Authorization tests
→ security review
→ rate limit
→ deploy HTTPS
→ rehearsal demo
```

## 19. Đánh giá tổng quan

| Tiêu chí | Đánh giá |
|---|---:|
| Phù hợp Full-Stack học kỳ 1 | 9.5/10 |
| Thể hiện React | 9/10 |
| Thể hiện Node.js | 10/10 |
| Thể hiện MongoDB | 9/10 |
| Tích hợp AI | 9.5/10 |
| Tính độc đáo nếu chỉ là multi-provider chat | 7/10 |
| Tính độc đáo khi có Discussion Mode | 8.5/10 |
| Khả năng demo | 9/10 |
| Giá trị portfolio | 9/10 |
| Độ khó kỹ thuật | 8.5/10 |
| Khả năng hoàn thành với MVP đã giới hạn | 8.5/10 |

## 20. Kết luận cuối cùng

**Nên chốt AgoraLLM và triển khai.** Không cần đổi bản chất thành một sản phẩm khác.

Phạm vi chính thức nên là:

> Ứng dụng chat đa provider theo cơ chế BYOK, hỗ trợ gọi từng model bằng `@model`, gọi nhiều model bằng `@all` và chạy Discussion Mode giới hạn để các model đưa ra quan điểm, phản biện và tổng hợp kết luận.

Ba ưu tiên cao nhất là:

1. **Bảo mật credential và authorization** — AES-256-GCM, không lộ key, chống IDOR, session an toàn.
2. **MVP hoàn thiện** — hai adapter/provider, chat, history, `@model`, `@all`, Discussion Mode giới hạn và deployment thật.
3. **Kiểm soát phạm vi** — không làm provider OAuth, custom endpoint tùy ý, RAG, voice, mobile hoặc agent trước khi MVP ổn định.

Dự án có tiềm năng đạt điểm tốt và trở thành portfolio mạnh nếu một luồng end-to-end được làm hoàn chỉnh, kiểm thử được và bảo vệ trung thực. Rủi ro lớn nhất không phải ý tưởng yếu, mà là cố làm quá nhiều tính năng khiến không tính năng nào đạt độ sâu cần thiết.
