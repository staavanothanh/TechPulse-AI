# MazeMind — AI Behavior-Adaptive Maze Engine

> Hệ thống sinh mê cung hiệu năng cao (C++/WASM), tích hợp AI phân tích hành vi giải đố để cá nhân hóa độ khó và đưa insight tư duy cho người chơi.

---

## 1. Ý tưởng cốt lõi

**Vấn đề của các sản phẩm maze generator hiện có (VisuAlgo, AI Maze Generator, mazegenerator.net...):**
Tất cả đều dừng ở mức "tạo mê cung theo tham số cố định" (size, độ khó chọn sẵn) và không có cơ chế nào học từ cách người chơi thực sự giải đố.

**MazeMind giải quyết bài toán khác:** không phải "tạo mê cung", mà là **hệ thống học hành vi người chơi để cá nhân hóa trải nghiệm và phản hồi insight về tư duy giải đố**. Mê cung chỉ là use-case để chứng minh hệ thống AI behavior-adaptive hoạt động.

**Định vị sản phẩm:** Kết hợp giữa "chơi" (game feel, UI/UX mượt) và "học" (hiểu cách bản thân tư duy khi giải vấn đề) — không ép học, nhưng luôn có insight cho ai tò mò.

---

## 2. Tech stack

| Thành phần | Công nghệ | Vai trò |
|---|---|---|
| Generation Engine | **C/C++ → WASM** (Emscripten) | Sinh mê cung tốc độ cao, chạy trực tiếp trên browser |
| Backend | **Node.js + Express** | API layer, xử lý behavior data, gọi AI |
| Database | **MongoDB** | Lưu user, lịch sử chơi, feature vector hành vi |
| Frontend | **React** | UI/UX chính, animation, hiển thị insight |
| AI — Adaptive Difficulty | **Rule-based weighted scoring** | Điều chỉnh độ khó dựa trên feature vector |
| AI — Insight Generation | **LLM API (Claude)** | Diễn giải feature vector thành insight ngôn ngữ tự nhiên |

---

## 3. Phân bổ effort (5-8 tuần)

- **C++/WASM Engine — 40%**: generation algorithms (DFS/Prim's/Kruskal's), tích hợp WASM ↔ JS, benchmark hiệu năng
- **AI System — 30%**: feature engineering, weighted scoring cho adaptive difficulty, prompt engineering cho insight generation
- **UI/UX — 30%**: animation sinh maze real-time, gameplay, hiển thị insight, theme

---

## 4. Feature cốt lõi

### 4.1 Generation Engine (C++/WASM)
- 2-3 thuật toán sinh maze (DFS/Prim's/Kruskal's) — mỗi thuật toán cho phong cách maze khác nhau
- Compile sang WASM, chạy client-side, không round-trip server
- Benchmark performance C++/WASM vs JS thuần (điểm chứng minh kỹ thuật)

### 4.2 Behavior Tracking
- Track chi tiết trong lúc chơi: số bước đi, số lần quay đầu, số lần vào ngõ cụt, thời gian dừng ở mỗi ngã rẽ, độ lệch so với đường đi tối ưu (BFS/A*)
- Lưu behavior data theo từng phiên chơi vào MongoDB

### 4.3 Feature Engineering
- Biến behavior thô thành feature vector có ý nghĩa:
  - Tỷ lệ bước đi lãng phí (wasted steps ratio)
  - Thời gian quyết định trung bình mỗi ngã rẽ
  - Tỷ lệ rẽ sai (wrong turns ratio)
  - Xu hướng chiến thuật (wall-following, trial-and-error, planning trước)

### 4.4 Adaptive Difficulty (Rule-based Weighted Scoring)
- Công thức mẫu:
  `difficulty_score = 0.4×wasted_steps_ratio + 0.3×avg_decision_time + 0.3×wrong_turns_ratio`
- Map điểm số sang tham số maze tiếp theo (size, mật độ ngõ cụt, độ phân nhánh)
- Không cần train model — quyết định kỹ thuật có cơ sở do giới hạn thời gian thu thập data thật

### 4.5 AI Insight Generation (LLM API)
- Sau mỗi phiên chơi, feature vector được đưa vào prompt → LLM sinh insight tự nhiên
- Ví dụ output: "Bạn đã đi 47 bước, đường tối ưu là 32 bước. Bạn có xu hướng lưỡng lự ở các ngã 3 và bám tường phải khi không chắc chắn."
- Không đưa đáp án, chỉ đưa nhận định về cách tư duy

### 4.6 Sáng tạo qua ngôn ngữ tự nhiên
- User nhập mô tả ("mê cung hình trái tim, độ khó trung bình") → AI parse yêu cầu → truyền tham số cho engine C++ sinh maze tương ứng

### 4.7 UI/UX
- Animation sinh maze theo thời gian thực (build từng cell)
- Chế độ "Xem AI giải" — so sánh đường đi AI (BFS/A*) với đường đi của user
- Theme tùy biến, dark/light mode
- Profile cá nhân: streak, biểu đồ tiến bộ theo thời gian

---

## 5. Trải nghiệm người dùng mong muốn

- **Lúc mới vào**: bất ngờ vì animation sinh maze mượt, đẹp
- **Trong lúc chơi**: cảm giác thử thách vừa sức — không quá dễ gây chán, không quá khó gây bỏ cuộc
- **Sau khi giải xong**: cảm giác "hiểu thêm về bản thân" chứ không chỉ "hoàn thành nhiệm vụ"
- **Sau nhiều lần chơi**: cảm giác sản phẩm "biết mình" — độ khó và gợi ý luôn đúng gu

---

## 6. Câu hỏi bảo vệ đồ án thường gặp (Q&A)

**Q: Sản phẩm này khác gì so với các maze generator có sẵn (VisuAlgo, mazegenerator.net...)?**
> Các sản phẩm hiện có dừng ở mức tạo mê cung theo tham số cố định do người dùng chọn thủ công. MazeMind xây dựng một hệ thống học hành vi liên tục — theo dõi cách người chơi thực sự giải đố (thời gian quyết định, tỷ lệ đi sai, chiến thuật sử dụng) để tự động điều chỉnh độ khó và đưa insight về tư duy, thứ không sản phẩm nào trên thị trường hiện có.

**Q: AI có thực sự cần thiết không, hay chỉ gắn cho có?**
> Nếu bỏ AI, sản phẩm chỉ còn là một maze generator thông thường — không còn khả năng cá nhân hóa hay insight. AI (behavior scoring + LLM insight) chính là core value, không phải tính năng phụ trợ.

**Q: Tại sao không train model Machine Learning thật thay vì dùng rule-based?**
> Training model cần lượng dữ liệu hành vi thật đủ lớn để có ý nghĩa thống kê, trong khi thời gian đồ án 5-8 tuần không đủ để thu thập data chất lượng từ nhiều người dùng thật. Rule-based weighted scoring là lựa chọn kỹ thuật phù hợp với ràng buộc thời gian, đồng thời vẫn đảm bảo tính giải thích được (explainable) — một ưu điểm mà black-box model không có. Đây là hướng phát triển tiếp theo nếu sản phẩm được mở rộng.

**Q: Tại sao dùng C++/WASM thay vì viết thuần JavaScript?**
> Generation engine cần xử lý các thuật toán đồ thị (DFS/Prim's/Kruskal's) trên grid lớn với hiệu năng cao, đặc biệt khi mở rộng kích thước maze hoặc tăng tần suất sinh lại theo adaptive difficulty. C++ compile sang WASM cho hiệu năng gần với native, đã được benchmark so với JS thuần để chứng minh lợi ích thực tế, không chỉ là lựa chọn công nghệ cho có.

**Q: Độ phức tạp kỹ thuật thực sự nằm ở đâu?**
> Ba điểm: (1) tích hợp WASM ↔ JS qua memory marshaling giữa C++ engine và React frontend, (2) thiết kế feature engineering biến behavior thô thành chỉ số phản ánh tư duy người chơi, (3) vòng lặp feedback real-time giữa behavior data → adaptive scoring → maze tiếp theo, đòi hỏi kiến trúc state management phù hợp.

**Q: Feature "sáng tạo qua ngôn ngữ tự nhiên" hoạt động thế nào?**
> LLM parse mô tả tự nhiên của người dùng thành tham số có cấu trúc (hình dạng, độ khó, kích thước), sau đó tham số này được truyền cho generation engine C++ để sinh maze tương ứng — đây là lớp kết nối giữa ngôn ngữ tự nhiên và thuật toán quyết định.

**Q: Sản phẩm có thể mở rộng thêm gì trong tương lai?**
> Thu thập đủ dữ liệu hành vi thật để huấn luyện model dự đoán độ khó chính xác hơn rule-based; mở rộng sang các loại puzzle khác dùng chung behavior-analysis engine; thêm tính năng social (chia sẻ maze tự tạo, leaderboard).
