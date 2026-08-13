const phaseCopy = { retrieving: ['Đang truy xuất nguồn', 'Chỉ chọn evidence primary/editorial còn visible.'], provider: ['Đang chờ dịch vụ trả lời', 'Chưa hiển thị nội dung suy đoán trong lúc xử lý.'], support: ['Đang kiểm tra mức hỗ trợ', 'Câu trả lời chỉ xuất hiện sau khi từng đoạn có citation.'] }

export default function GenerationProgress({ phase = 'retrieving' }) {
  const [title, body] = phaseCopy[phase] ?? phaseCopy.retrieving
  return <section className="qa-progress" aria-busy="true"><span className="qa-eyebrow">Grounded generation</span><h3>{title}</h3><p>{body}</p><div className="qa-progress-steps"><span className={phase === 'retrieving' ? 'current' : ''}>Truy xuất</span><span className={phase === 'provider' ? 'current' : ''}>Tạo câu trả lời</span><span className={phase === 'support' ? 'current' : ''}>Kiểm tra</span></div></section>
}
