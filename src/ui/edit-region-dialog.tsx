import { useEffect, useRef, useState } from 'react'

interface Region {
  x: number
  y: number
  width: number
  height: number
}

interface Props {
  imageUrl: string
  onCancel: () => void
  onConfirm: (maskedImage: string) => void
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function regionOf(start: { x: number; y: number }, end: { x: number; y: number }): Region {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  }
}

export function EditRegionDialog({ imageUrl, onCancel, onConfirm }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const dragStartRef = useRef<{ x: number; y: number } | null>(null)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [region, setRegion] = useState<Region | null>(null)

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
    if (!region) return

    context.fillStyle = 'rgba(215, 71, 52, 0.28)'
    context.fillRect(region.x, region.y, region.width, region.height)
    context.strokeStyle = '#d74734'
    context.lineWidth = Math.max(3, size.width / 512)
    context.strokeRect(region.x, region.y, region.width, region.height)
  }, [region, size])

  function pointOf(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    return {
      x: clamp((event.clientX - rect.left) * (canvas.width / rect.width), 0, canvas.width),
      y: clamp((event.clientY - rect.top) * (canvas.height / rect.height), 0, canvas.height),
    }
  }

  function startSelection(event: React.PointerEvent<HTMLCanvasElement>) {
    const point = pointOf(event)
    dragStartRef.current = point
    setRegion({ x: point.x, y: point.y, width: 0, height: 0 })
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function moveSelection(event: React.PointerEvent<HTMLCanvasElement>) {
    const start = dragStartRef.current
    if (!start) return
    setRegion(regionOf(start, pointOf(event)))
  }

  function finishSelection(event: React.PointerEvent<HTMLCanvasElement>) {
    const start = dragStartRef.current
    if (!start) return
    setRegion(regionOf(start, pointOf(event)))
    dragStartRef.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  function confirm() {
    const image = imageRef.current
    if (!image || !size || !region || region.width < 4 || region.height < 4) return

    const output = document.createElement('canvas')
    output.width = size.width
    output.height = size.height
    const context = output.getContext('2d')
    if (!context) return
    context.drawImage(image, 0, 0)

    const left = Math.max(0, Math.floor(region.x))
    const top = Math.max(0, Math.floor(region.y))
    const right = Math.min(size.width, Math.ceil(region.x + region.width))
    const bottom = Math.min(size.height, Math.ceil(region.y + region.height))
    const border = Math.max(8, Math.min(32, Math.floor(Math.min(region.width, region.height) / 8)))
    const pixels = context.getImageData(0, 0, size.width, size.height).data
    let red = 0
    let green = 0
    let blue = 0
    let count = 0
    for (let y = Math.max(0, top - border); y < Math.min(size.height, bottom + border); y += 4) {
      for (let x = Math.max(0, left - border); x < Math.min(size.width, right + border); x += 4) {
        if (x >= left && x < right && y >= top && y < bottom) continue
        const index = (y * size.width + x) * 4
        red += pixels[index]!
        green += pixels[index + 1]!
        blue += pixels[index + 2]!
        count += 1
      }
    }
    const fill = count > 0
      ? `rgb(${Math.round(red / count)}, ${Math.round(green / count)}, ${Math.round(blue / count)})`
      : 'rgb(128, 128, 128)'
    context.fillStyle = fill
    context.fillRect(left, top, right - left, bottom - top)
    onConfirm(output.toDataURL('image/png'))
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 20,
        display: 'grid',
        placeItems: 'center',
        padding: 20,
        background: 'rgba(25, 35, 42, 0.56)',
      }}
    >
      <div
        style={{
          width: 'min(900px, 94vw)',
          maxHeight: '94vh',
          overflow: 'auto',
          padding: 16,
          borderRadius: 12,
          background: '#fff',
          boxShadow: '0 12px 40px rgba(0, 0, 0, 0.24)',
        }}
      >
        <h2 style={{ margin: '0 0 6px', fontSize: 16 }}>編集範囲を指定</h2>
        <p style={{ margin: '0 0 12px', fontSize: 12, color: '#5c6b73' }}>
          変更したい範囲をドラッグしてください。ロゴタイプに限らず、画像内の任意の領域を指定できます。
        </p>
        <canvas
          ref={canvasRef}
          onPointerDown={startSelection}
          onPointerMove={moveSelection}
          onPointerUp={finishSelection}
          style={{
            display: 'block',
            width: 'auto',
            height: 'auto',
            maxWidth: '100%',
            maxHeight: '68vh',
            margin: '0 auto',
            border: '1px solid #d8dfe3',
            borderRadius: 8,
            cursor: 'crosshair',
            touchAction: 'none',
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button type="button" onClick={onCancel} style={{ padding: '7px 14px' }}>
            キャンセル
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={!region || region.width < 4 || region.height < 4}
            style={{ padding: '7px 14px' }}
          >
            この範囲で編集
          </button>
        </div>
      </div>
    </div>
  )
}
