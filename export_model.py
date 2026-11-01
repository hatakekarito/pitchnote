"""YOLOv8 を ONNX に書き出して、このフォルダに yolov8n.onnx として置くスクリプト。

使い方:
  pip install ultralytics onnx onnxsim
  python export_model.py            # 640 (標準)
  python export_model.py 1280       # 小さいボール向け。config.js の inputSize も 1280 に
  python export_model.py 640 my_soccer_model.pt   # 自作モデル
"""
import shutil
import sys
from pathlib import Path

from ultralytics import YOLO

size = int(sys.argv[1]) if len(sys.argv) > 1 else 640
weights = sys.argv[2] if len(sys.argv) > 2 else "yolov8n.pt"

model = YOLO(weights)
path = model.export(format="onnx", imgsz=size, opset=12, simplify=True, dynamic=False)

dest = Path(__file__).resolve().parent / "yolov8n.onnx"
shutil.copy(path, dest)
mb = dest.stat().st_size / 1024 / 1024
print(f"書き出し完了: {dest} ({mb:.1f} MB)")
if mb > 25:
    print("注意: Cloudflare Pages は1ファイル25MBまでです。README の「モデルが大きい場合」を参照してください。")
print("names:", model.names)
