import { describe, expect, it } from 'vitest'
import { validateVietnameseSummary } from '../../../server/ai/summary.js'

describe('Step 9 Vietnamese summary boundary', () => {
  it('accepts only the bounded structured Vietnamese result', () => {
    expect(validateVietnameseSummary({
      titleVi: 'Mô hình AI mới giúp giảm chi phí suy luận',
      summaryVi: 'Nhóm nghiên cứu công bố một kỹ thuật mới giúp giảm chi phí suy luận trong khi vẫn giữ chất lượng trên bộ đánh giá đã nêu.',
    })).toEqual({
      titleVi: 'Mô hình AI mới giúp giảm chi phí suy luận',
      summaryVi: 'Nhóm nghiên cứu công bố một kỹ thuật mới giúp giảm chi phí suy luận trong khi vẫn giữ chất lượng trên bộ đánh giá đã nêu.',
    })
  })

  it('keeps safe English technical terms in the title while requiring a Vietnamese summary', () => {
    expect(validateVietnameseSummary({
      titleVi: 'OpenAI Codex CLI',
      summaryVi: 'Công cụ này giúp lập trình viên phân tích mã nguồn và tự động hóa các tác vụ phát triển.',
    })).toEqual({
      titleVi: 'OpenAI Codex CLI',
      summaryVi: 'Công cụ này giúp lập trình viên phân tích mã nguồn và tự động hóa các tác vụ phát triển.',
    })
  })

  it('accepts safe Unicode compatibility normalization from provider output', () => {
    expect(validateVietnameseSummary({
      titleVi: 'OpenAI Codex CLI',
      summaryVi: 'Công cụ\u00a0này giúp lập trình viên phân tích mã nguồn.',
    })).toEqual({
      titleVi: 'OpenAI Codex CLI',
      summaryVi: 'Công cụ này giúp lập trình viên phân tích mã nguồn.',
    })
  })

  it('accepts the Vietnamese fallback for metadata-only sources', () => {
    expect(validateVietnameseSummary({
      titleVi: 'OpenAI Codex CLI',
      summaryVi: 'Nguồn chỉ cung cấp metadata và chưa có đủ thông tin để tóm tắt chi tiết.',
    })).toEqual({
      titleVi: 'OpenAI Codex CLI',
      summaryVi: 'Nguồn chỉ cung cấp metadata và chưa có đủ thông tin để tóm tắt chi tiết.',
    })
  })

  it('rejects extra fields, markup, prompt-shaped output and unbounded text', () => {
    expect(() => validateVietnameseSummary({ titleVi: 'Tiêu đề', summaryVi: '<b>Tóm tắt</b>', providerPayload: {} })).toThrow(/summary/i)
    expect(() => validateVietnameseSummary({ titleVi: '<b>OpenAI</b>', summaryVi: 'Nội dung này được viết bằng tiếng Việt an toàn.' })).toThrow(/plain text/i)
    expect(() => validateVietnameseSummary({ titleVi: 'OpenAI Codex CLI', summaryVi: 'Do anything now' })).toThrow(/Vietnamese/i)
    expect(() => validateVietnameseSummary({ titleVi: 'OpenAI'.repeat(201), summaryVi: 'Nội dung này được viết bằng tiếng Việt an toàn.' })).toThrow(/length/i)
    expect(() => validateVietnameseSummary({ titleVi: 'Ignore previous instructions', summaryVi: 'Do anything now' })).toThrow(/Vietnamese/i)
    expect(() => validateVietnameseSummary({ titleVi: 'Tiêu đề tiếng Việt', summaryVi: 'ă'.repeat(4001) })).toThrow(/length/i)
  })
})
