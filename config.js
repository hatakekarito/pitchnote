// 調整用の設定値。GitHub 上で鉛筆マークから編集できます。
export const CONFIG = {
  // AIモデル（index.html と同じ場所に置く）
  modelUrl: './yolov8n.onnx',
  ortWasmPath: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/',
  inputSize: 640,

  // クラス番号（COCO学習済みモデル：person=0 / sports ball=32）
  classes: { person: 0, ball: 32 },
  personConf: 0.2,
  ballConf: 0.12,
  nmsIou: 0.5,

  // 横長の映像を分割して推論（小さいボールが見つけやすくなる。処理は遅くなる）
  tilesX: 2,
  tileOverlap: 0.15,

  // 1秒あたりの解析コマ数（下げると速く、上げると正確）
  sampleFps: 8,

  // ユニフォームの色の判定
  color: {
    maxDist: 42,   // 登録した色からこれ以上離れている人は「どれでもない」として除外
    ratio: 0.8,    // 1番近い色が2番目よりはっきり近いときだけ判定
    minVotes: 3,   // チームを決めるのに必要な判定回数
  },

  // カメラの動きの推定
  motion: {
    width: 320,    // 推定に使う縮小画像の幅
    maxScale: 0.15,// 1コマで許すズーム変化の割合
  },

  tracker: {
    highThresh: 0.45,
    matchThresh: 0.3,
    lowMatchThresh: 0.4,
    maxMissed: 24,
    minHits: 3,
  },

  analysis: {
    playerHeight: 1.4,     // 選手の平均身長(m)。画面上の距離をおおよそのメートルに換算するのに使う
    possessionRadius: 1.5, // ボール保持とみなす距離（m・目安）
    controlSpeed: 7,       // これより速いボールは保持とみなさない（m/s・目安）
    minPossessionFrames: 2,
    minPassLength: 4,      // これより短い移動はパスに数えない（m・目安）
    maxPassTime: 4,        // 秒
    shotSpeed: 9,          // シュートとみなすボール速度（m/s・目安）
    attackZone: 0.62,      // 攻撃側この割合より奥でのキックだけシュート候補に
    dribbleMin: 7,         // ドリブルとして実況する距離（m・目安）
    maxBallSpeed: 40,      // これを超えるボール移動は誤検出として除外（m/s）
    ballMaxGap: 1.0,       // ボールを見失った区間を補間する最大秒数
  },

  // 番号付け
  labeling: {
    minTime: 3,        // これより短くしか映っていない追跡は一覧に出さない（秒）
    maxGap: 8,         // 見失ってから何秒以内に現れた選手を「同じ子かも」の候補にするか
    maxSpeed: 6.5,     // 候補にする移動の速さの上限（m/s）
    thumbsPerTrack: 3, // 追跡1件あたりに残す写真の数
    thumbHeight: 150,  // 写真の高さ（px）
    thumbMinPx: 40,    // これより小さく映っているときは写真を残さない（px）
    thumbInterval: 1,  // 同じ人の写真を撮り直す最短の間隔（秒）
    thumbSpacing: 3,   // 残す写真どうしの時間の間隔（秒）
  },

  // レポート
  report: {
    joinGap: 4,         // 同じチームの保持がこの秒数以内に続けば1つの攻撃とみなす
    minPhaseTouches: 2, // これ未満のタッチの攻撃は「試合の流れ」から省く（シュート・ドリブル・長い保持は残す）
    minPhaseSec: 6,
  },
};
