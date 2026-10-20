//! Immutable assets and hashes, checked before installation and before executing downloaded code.
use sha2::{Digest, Sha256};
use std::{fs::File, io::Read, path::Path};

pub struct Asset {
    pub name: &'static str,
    pub url: &'static str,
    pub bytes: u64,
    pub sha256: &'static str,
}
pub const DET: Asset = Asset {
    name: "det.onnx", bytes: 4_819_576,
    url: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2/onnx/PP-OCRv5/det/ch_PP-OCRv5_det_mobile.onnx",
    sha256: "4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae",
};
pub const REC: Asset = Asset {
    name: "rec.onnx", bytes: 84_577_022,
    url: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2/onnx/PP-OCRv5/rec/ch_PP-OCRv5_rec_server.onnx",
    sha256: "e09385400eaaaef34ceff54aeb7c4f0f1fe014c27fa8b9905d4709b65746562a",
};
pub const RUNTIME: Asset = Asset {
    name: "runtime.zip", bytes: 72_368_545,
    url: "https://github.com/microsoft/onnxruntime/releases/download/v1.22.0/onnxruntime-win-x64-1.22.0.zip",
    sha256: "174c616efc0271194488642a72f1a514e01487da4dfe84c49296d66e40ebe0da",
};
pub const RUNTIME_FILES: &[(&str, u64, &str)] = &[
    (
        "onnxruntime.dll",
        12_418_080,
        "579b636403983254346a5c1d80bd28f1519cd1e284cd204f8d4ff41f8d711559",
    ),
    (
        "onnxruntime_providers_shared.dll",
        22_064,
        "ba00ea1ef846c9b909c7854bc56c51051a20f9773b3e1153dda118d4b85d0b93",
    ),
    (
        "LICENSE",
        1094,
        "c250d6278f0b47a6439fb7592b08b58a55eb9f535aa49a1db63211c3f982b674",
    ),
    (
        "ThirdPartyNotices.txt",
        333_022,
        "e00f828e0a33de591a355ae6606d2625f5758da7d2c844db7821c9dd3e3647b6",
    ),
];
pub const VERSION: &str = "ppocrv5-onnx-3.9.2-ort-1.22.0";
pub const DOWNLOAD_BYTES: u64 = DET.bytes + REC.bytes + RUNTIME.bytes;

pub fn check_file(path: &Path, bytes: u64, sha256: &str) -> Result<(), String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() != bytes {
        return Err("OCR_MODEL_CORRUPT".into());
    }
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    if format!("{:x}", hash.finalize()) != sha256 {
        return Err("OCR_MODEL_CORRUPT".into());
    }
    Ok(())
}

pub fn verify(directory: &Path) -> Result<(), String> {
    for asset in [&DET, &REC] {
        check_file(&directory.join(asset.name), asset.bytes, asset.sha256)?;
    }
    for &(name, bytes, hash) in RUNTIME_FILES {
        check_file(&directory.join(name), bytes, hash)?;
    }
    Ok(())
}
