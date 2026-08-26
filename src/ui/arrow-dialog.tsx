/**
 * 矢印を引く場所を指す（D-020）。
 *
 * **どこを指すかは利用者にしか分からない。** こちらで推測すると、頼まれていない所を
 * 指した図が出る。画面で引いてもらい、その位置をそのまま引数にする。
 *
 * 位置は**画像の大きさに対する％**で返す。画素で返すと、後からリサイズしたときに
 * 指す所がずれる。％なら記録としても読める（`toolArguments` に残る）。
 */
import { useEffect, useRef, useState } from 'react'

export interface ArrowSelection {
  /** 始点（矢の根元）。画像の大きさに対する％ */
  x1: number
  y1: number
  /** 終点（矢じり）。ここが指したい所 */
  x2: number
  y2: number
  text?: string
}

interface Props {
  imageUrl: string
  onCancel: () => void
  onConfirm: (selection: ArrowSelection) => void
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function ArrowDialog({ imageUrl, onCancel, onConfirm }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const draggingRef = useRef(false)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [tail, setTail] = useState<{ x: number; y: number } | null>(null)
  const [head, setHead] = useState<{ x: number; y: number } | null>(null)
  const [label, setLabel] = useState('')

  useEffect(() => {
    const image = new Image()
    image.onload = () => {
      imageRef.current = image
      setSize({ width: image.naturalWidth, height: image.naturalHeight })
    }
    image.src = imageUrl
    return () => {
      image.onload = null
      imageRef.current = null
    }
  }, [imageUrl])

  useEffect(() => {
    const canvas = canvasRef.current
    const image = imageRef.current
    if (!canvas || !image || !size) return
    canvas.width = size.width
    canvas.height = size.height
    const context = canvas.getContext('2d')
    if (!context) return
    context.clearRect(0, 0, size.width, size.height)
    context.drawImage(image, 0, 0)
    if (!tail || !head) return

    // 下絵はあくまで目安。実際の描画は Jimp が確定的にやる
    const thickness = Math.max(3, size.width / 320)
    context.strokeStyle = '#d74734'
    context.lineWidth = thickness
    context.beginPath()
    context.moveTo(tail.x, tail.y)
    context.lineTo(head.x, head.y)
    context.stroke()
    const angle = Math.atan2(head.y - tail.y, head.x - tail.x)
    const barb = Math.max(10, Math.min(size.width, size.height) * 0.05)
    for (const spread of [(Math.PI * 5) / 6, (-Math.PI * 5) / 6]) {
      context.beginPath()
      context.moveTo(head.x, head.y)
      context.lineTo(head.x + barb * Math.cos(angle + spread), head.y + barb * Math.sin(angle + spread))
      context.stroke()
    }
  }, [tail, head, size])

  function pointOf(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    return {
      x: clamp((event.clientX - rect.left) * (canvas.width / rect.width), 0, canvas.width),
      y: clamp((event.clientY - rect.top) * (canvas.height / rect.height), 0, canvas.height),
    }
  }

  function confirm() {
    if (!tail || !head || !size) return
    const toPercent = (value: number, total: number) =>
      Math.round(clamp((value / Math.max(1, total - 1)) * 100, 0, 100))
    const selection: ArrowSelection = {
      x1: toPercent(tail.x, size.width),
      y1: toPercent(tail.y, size.height),
      x2: toPercent(head.x, size.width),
      y2: toPercent(head.y, size.height),
      ...(label.trim() ? { text: label.trim().slice(0, 40) } : {}),
    }
    // 始点と終点が同じでは向きが決まらない。ここで止めて、引き直してもらう
    if (selection.x1 === selection.x2 && selection.y1 === selection.y2) return
    onConfirm(selection)
  }

  const ready = tail !== null && head !== null

  return (
    <div
      role="dialog"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(20,28,34,.5)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 50,
      }}
    >
      <div style={{ background: '#fff', borderRadius: 12, padding: 16, width: 'min(760px, 92vw)' }}>
        <h2 style={{ fontSize: 15, margin: '0 0 4px' }}>矢印を引く</h2>
        <p style={{ fontSize: 12, color: '#5c6b73', margin: '0 0 10px' }}>
          <strong>指したい物へ向かってドラッグ</strong>してください（離した所が矢じりです）。
          位置は画像の大きさに対する％として来歴に残るので、
          <strong>後から縮めても指す所は変わりません</strong>。
        </p>
        <div style={{ maxHeight: '52vh', overflow: 'auto', marginBottom: 10 }}>
          <canvas
            ref={canvasRef}
            style={{ width: '100%', display: 'block', cursor: 'crosshair', touchAction: 'none' }}
            onPointerDown={(event) => {
              const point = pointOf(event)
              draggingRef.current = true
              setTail(point)
              setHead(point)
              event.currentTarget.setPointerCapture(event.pointerId)
            }}
            onPointerMove={(event) => {
              if (!draggingRef.current) return
              setHead(pointOf(event))
            }}
            onPointerUp={(event) => {
              if (!draggingRef.current) return
              draggingRef.current = false
              setHead(pointOf(event))
              event.currentTarget.releasePointerCapture(event.pointerId)
            }}
          />
        </div>
        <input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="矢印に添える文字（任意・40文字まで）"
          style={{
            width: '100%',
            boxSizing: 'border-box',
            border: '1px solid #d8dfe3',
            borderRadius: 8,
            padding: '8px 10px',
            font: 'inherit',
            fontSize: 13,
            marginBottom: 10,
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={onCancel} style={{ padding: '7px 14px', fontSize: 13 }}>
            やめる
          </button>
          <button
            type="button"
            disabled={!ready}
            onClick={confirm}
            style={{ padding: '7px 14px', fontSize: 13 }}
          >
            この矢印にする
          </button>
        </div>
      </div>
    </div>
  )
}
