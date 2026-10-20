# Third-party notices

## Optional OCR components

The default installer contains neither OCR model weights nor the ONNX Runtime DLLs.
Users may download the following components from Settings → Text recognition:

- PP-OCRv5 detection and recognition models, developed by PaddlePaddle/PaddleOCR,
  under Apache-2.0. The ONNX conversions are distributed by RapidAI/RapidOCR on
  ModelScope. The complete [PaddleOCR license](docs/PaddleOCR-LICENSE) is copied
  into the component directory during installation.
- Microsoft ONNX Runtime 1.22.0 CPU DLLs under the MIT License. The official
  runtime archive's `LICENSE` and `ThirdPartyNotices.txt` are retained alongside
  the DLLs, including notices for its dependencies.

The application uses the `ort` Rust bindings (MIT OR Apache-2.0) for dynamic
loading. Model versions, sources, hashes and installation behavior are documented
in the [OCR guide](docs/ocr.md). Repository-owned OCR integration code remains
under this repository's MIT License.

## Live2D Cubism SDK for Web

This repository bundles components of the Live2D Cubism SDK for Web:

- `src/live2d-framework/` and `public/live2d/shaders/` are Copyright © Live2D Inc.
  They are governed by the [Live2D Open Software License Agreement](https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html).
- `public/live2d/live2dcubismcore.min.js` is Copyright © Live2D Inc. and is
  Redistributable Code governed by the [Live2D Proprietary Software License
  Agreement](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html).

These components are not covered by this repository's MIT License. Before
distributing a build containing them, the release owner must confirm that the
release complies with Live2D's [SDK Release License requirements](https://www.live2d.com/en/sdk/license/),
including whether the publisher qualifies for an exemption or needs a separate
publication license.

## Clover Girl model and artwork

`public/pet-model/clover-girl-2/` contains the Clover Girl model, motions,
texture, and associated generated files. It is not a Live2D sample asset. The
release owner confirms that they created the model and artwork with AI
assistance, own the applicable rights, and authorize its public distribution
with this project. This confirmation does not alter the separately applicable
Live2D SDK terms above.
