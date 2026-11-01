// 調整用の設定値。ここを書き換えれば挙動を変えられます。
export const CONFIG = {
  // YOLO モデル（ONNX形式）。README の手順でこのフォルダに置いてください。
  modelUrl: './yolov8n.onnx',
  ortWasmPath: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/',
  inputSize: 640, // モデルを書き出したときの imgsz と合わせる（640 or 1280）

  // クラス番号。COCO学習済みなら person=0 / sports ball=32。
  // 自作のサッカー用モデルを使う場合はその番号に変更。
  classes: { person: 0, ball: 32 },
  personConf: 0.2,
  ballConf: 0.12,
  nmsIou: 0.5,

  // 横長の映像を左右に分割して推論（小さいボール・選手の検出精度が上がる。処理時間は増える）
  tilesX: 2,
  tileOverlap: 0.15,

  // 1秒あたりの解析コマ数。上げると精度↑・速度↓
  sampleFps: 10,

  // 少年サッカー（8人制）の標準的なピッチ寸法（m）
  pitch: { length: 68, width: 50, goalWidth: 5 },

  tracker: {
    highThresh: 0.45,   // これ以上の検出で新しい選手を登録
    matchThresh: 0.3,   // 1段目の対応付けのしきい値
    lowMatchThresh: 0.4,// 低スコア検出での2段目の対応付け
    maxMissed: 30,      // 見失ってから保持するコマ数（10fpsで3秒）
    minHits: 3,         // 何コマ連続で見えたら選手として確定するか
  },

  analysis: {
    possessionRadius: 1.8, // ボール保持とみなす距離（m）
    controlSpeed: 6,       // これより速いボールは保持とみなさない（m/s）
    minPossessionFrames: 2,
    minPassLength: 3,      // これより短い移動はパスに数えない（m）
    maxPassTime: 4,        // 秒
    shotSpeed: 8,          // シュートとみなすボール速度（m/s）
    shotAngleDeg: 35,      // ゴール方向とのずれの許容角
    shotMaxDist: 25,       // ゴールからこの距離以内で蹴った場合のみ（m）
    dribbleMin: 8,         // ドリブルとして実況する運んだ距離（m）
    sprintSpeed: 4.2,      // スプリント判定（m/s ≒ 15km/h、小学生向け）
    maxPlayerSpeed: 9,     // これを超える移動は追跡ミスとして除外（m/s）
    maxBallSpeed: 35,      // これを超えるボール移動は誤検出として除外（m/s）
    ballMaxGap: 1.0,       // ボールを見失った区間を補間する最大秒数
  },

  minPlayerTime: 5, // 記録表に載せる最低出場秒数
};
