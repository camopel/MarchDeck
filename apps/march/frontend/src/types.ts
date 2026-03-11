// Types for March Chat

export interface Session {
  id: string
  name: string
  description: string
  created_at: string
  last_active: string
  is_active: boolean
  last_message?: string | null
  last_message_role?: string | null
  message_count?: number
}

export interface Message {
  id: string
  session_id: string
  role: 'user' | 'assistant'
  content: string
  tool_calls: ToolCall[]
  created_at: string
  /** Base64 image data URI for image attachments (e.g. "data:image/jpeg;base64,...") */
  image_data?: string
}

export interface ToolCall {
  name: string
  args?: Record<string, unknown>
  result?: string
}

// WebSocket message types from March
export interface WsStreamStart {
  type: 'stream.start'
}

export interface WsStreamDelta {
  type: 'stream.delta'
  content: string
}

export interface WsStreamEnd {
  type: 'stream.end'
  cancelled?: boolean
  usage?: {
    input_tokens: number
    output_tokens: number
    cost: number
  }
}

export interface WsToolStart {
  type: 'tool.start'
  name: string
  args: Record<string, unknown>
}

export interface WsToolResult {
  type: 'tool.result'
  name: string
  result: string
}

export interface WsToolProgress {
  type: 'tool.progress'
  name: string
  status: string
  summary: string
  duration_ms: number
}

export interface WsError {
  type: 'error'
  message: string
}

export interface WsMessageQueued {
  type: 'message.queued'
  count: number
}

export interface WsVoiceTranscribed {
  type: 'voice.transcribed'
  text: string
}

export interface WsImagePreview {
  type: 'image.preview'
  /** Base64-encoded JPEG data (no data URI prefix) */
  data: string
  mime_type: string
  filename: string
}

export interface WsStreamActive {
  type: 'stream.active'
  chunk_id: number
  collected: string
}

export interface WsStreamCatchup {
  type: 'stream.catchup'
  content: string
  done: boolean
  chunk_id: number
}

export interface WsStreamResumed {
  type: 'stream.resumed'
  chunk_id: number
}

export interface WsStreamIdle {
  type: 'stream.idle'
}

export interface WsStreamCancelled {
  type: 'stream.cancelled'
}

export interface WsSessionReset {
  type: 'session.reset'
}

export type WsMessage =
  | WsStreamStart
  | WsStreamDelta
  | WsStreamEnd
  | WsToolStart
  | WsToolResult
  | WsToolProgress
  | WsError
  | WsMessageQueued
  | WsVoiceTranscribed
  | WsImagePreview
  | WsStreamActive
  | WsStreamCatchup
  | WsStreamResumed
  | WsStreamIdle
  | WsStreamCancelled
  | WsSessionReset

// Streaming state for the current response
export interface StreamingState {
  isStreaming: boolean
  content: string
  activeTools: string[]  // tool names currently running
  toolProgress: { name: string; status: string; summary: string; duration_ms: number }[]
}
