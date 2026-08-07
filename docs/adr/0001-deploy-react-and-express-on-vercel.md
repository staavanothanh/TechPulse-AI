# ADR-0001: Deploy React and Express together on Vercel

**Date**: 2026-08-08  
**Status**: accepted  
**Deciders**: Project owner  
**Record type**: Backfill of an approved MVP decision

## Context

TechPulse AI phải có public URL phục vụ demo sau bốn tuần và phạm vi phải đủ cho một người hoàn thành. Frontend dùng React/Vite, backend dùng Node.js/Express và job hằng ngày cần một scheduler. Tách nhiều hosting platform làm tăng cấu hình, secret, CORS và điểm lỗi trong khi MVP chỉ có 250–400 article.

## Decision

Một Vercel Hobby project host React static build, Express Function và một protected daily cron endpoint. Local và production dùng cùng Express application; chỉ entrypoint/deployment adapter khác nhau.

## Alternatives Considered

### Alternative 1: Render cho toàn bộ ứng dụng

- **Pros**: Node service quen thuộc và phù hợp process dài hơn.
- **Cons**: Không còn deployment target đã chốt; phải thiết kế lại scheduler và demo configuration.
- **Why not**: Project owner đã chọn Vercel và kiến trúc bounded job có thể làm việc trong serverless constraints.

### Alternative 2: Vercel frontend và Render backend

- **Pros**: Frontend deploy đơn giản, backend có process riêng.
- **Cons**: Hai deployment, hai domain/config surface, CORS và secret coordination.
- **Why not**: Chi phí vận hành không tạo thêm giá trị cho vertical slice bốn tuần.

### Alternative 3: Chỉ demo local

- **Pros**: Ít hạ tầng nhất.
- **Cons**: Không đáp ứng mục tiêu public deployment phục vụ chấm đồ án.
- **Why not**: Deployment là một acceptance gate đã chốt.

## Consequences

### Positive

- Một deployment URL và một nơi quản lý environment variables.
- React, API và cron có thể demo trong cùng project.
- Local fallback vẫn dùng cùng business application.

### Negative

- Không được giả định process luôn sống, filesystem bền vững hoặc background work tiếp tục sau response.
- Mọi job phải có batch/time budget và checkpoint.

### Risks

- Hobby plan hoặc provider quota có thể thay đổi; kiểm tra lại trước ngày demo và giữ local runbook.
- Function deadline có thể tạo job `partial`; runner dừng sớm, checkpoint và resume thay vì mất tiến độ.
