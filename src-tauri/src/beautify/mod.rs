mod model;
use base64::Engine;
pub use model::{EditContext, Library};
use sha2::{Digest, Sha256};
use std::{fs, path::Path, sync::Mutex};

static STORE_LOCK: Mutex<()> = Mutex::new(());
const ASSET_LIMIT: u64 = 8 * 1024 * 1024;

fn load(path: &Path) -> Result<Library, String> {
    if !path.exists() {
        return Ok(Library::default());
    }
    if fs::metadata(path).map_err(|e| e.to_string())?.len() > 1024 * 1024 {
        return Err("beautify.invalidLibrary".into());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let mut library: Library =
        serde_json::from_slice(&bytes).map_err(|_| "beautify.invalidLibrary")?;
    library.migrate();
    library.validate()?;
    Ok(library)
}

fn save(path: &Path, mut library: Library, expected: u64) -> Result<Library, String> {
    library.validate()?;
    let current = load(path)?;
    if expected != current.revision {
        return Err("beautify.conflict".into());
    }
    library.revision = current
        .revision
        .checked_add(1)
        .ok_or("beautify.invalidLibrary")?;
    let bytes = serde_json::to_vec_pretty(&library).map_err(|e| e.to_string())?;
    if bytes.len() > 1024 * 1024 {
        return Err("beautify.invalidLibrary".into());
    }
    crate::atomic_file::write(path, &bytes).map_err(|e| e.to_string())?;
    Ok(library)
}

#[tauri::command]
pub async fn get_beautify_library() -> Result<Library, String> {
    crate::image_tasks::run(|| {
        let _guard = STORE_LOCK.lock().map_err(|e| e.to_string())?;
        load(&crate::config::get_config_dir().join("beautify.json"))
    })
    .await
}

#[tauri::command]
pub async fn save_beautify_library(
    library: Library,
    expected_revision: u64,
) -> Result<Library, String> {
    crate::image_tasks::run(move || {
        let _guard = STORE_LOCK.lock().map_err(|e| e.to_string())?;
        save(
            &crate::config::get_config_dir().join("beautify.json"),
            library,
            expected_revision,
        )
    })
    .await
}

fn import_asset(source: &Path, directory: &Path) -> Result<String, String> {
    if fs::metadata(source).map_err(|e| e.to_string())?.len() > ASSET_LIMIT {
        return Err("beautify.assetTooLarge".into());
    }
    let bytes = fs::read(source).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > ASSET_LIMIT
        || image::guess_format(&bytes).ok() != Some(image::ImageFormat::Png)
    {
        return Err("beautify.invalidAsset".into());
    }
    let reader =
        image::ImageReader::with_format(std::io::Cursor::new(&bytes), image::ImageFormat::Png);
    let (w, h) = reader
        .into_dimensions()
        .map_err(|_| "beautify.invalidAsset")?;
    if w == 0 || h == 0 || u64::from(w) * u64::from(h) > 16_000_000 {
        return Err("beautify.assetTooLarge".into());
    }
    image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
        .map_err(|_| "beautify.invalidAsset")?;
    let id = format!("{:x}", Sha256::digest(&bytes));
    fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    crate::atomic_file::write(&directory.join(format!("{id}.png")), &bytes)
        .map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub async fn import_beautify_asset(path: String) -> Result<String, String> {
    crate::image_tasks::run(move || {
        import_asset(
            Path::new(&path),
            &crate::config::get_config_dir().join("beautify-assets"),
        )
    })
    .await
}

#[tauri::command]
pub async fn read_beautify_asset(id: String) -> Result<String, String> {
    crate::image_tasks::run(move || {
        if !model::asset_id(&id) {
            return Err("beautify.missingAsset".into());
        }
        let path = crate::config::get_config_dir()
            .join("beautify-assets")
            .join(format!("{id}.png"));
        if fs::metadata(&path)
            .map_err(|_| "beautify.missingAsset")?
            .len()
            > ASSET_LIMIT
        {
            return Err("beautify.assetTooLarge".into());
        }
        let bytes = fs::read(path).map_err(|_| "beautify.missingAsset")?;
        Ok(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn document() -> serde_json::Value {
        serde_json::json!({"enabled":true,"referenceSize":1000,"frame":{
            "kind":"gradient","padding":[48,48,120,48],"borderWidth":2,"borderColor":"#ffffff",
            "background":"#dbeafe","backgroundEnd":"#d8b4fe","angle":135,"radius":16,"shadow":16
        },"watermarks":[]})
    }
    #[test]
    fn version_one_migrates_without_writing_or_losing_ids_and_revisions() {
        let dir = folder();
        let path = dir.join("beautify.json");
        let before = serde_json::to_vec(&serde_json::json!({"schema":1,"revision":7,"autoApply":true,
            "defaultPresetId":"mine","lastPresetId":"gradient","presets":[{"id":"mine","name":"My template","document":document()}]})).unwrap();
        fs::write(&path, &before).unwrap();
        let library = load(&path).unwrap();
        assert_eq!(library.schema, 3);
        assert_eq!(library.revision, 7);
        assert_eq!(library.default_preset_id, "mine");
        assert_eq!(library.last_preset_id, "gradient");
        assert!(library.auto_apply);
        assert_eq!(library.presets[0].document.frame.kind, "card");
        assert_eq!(
            library.presets[0]
                .document
                .background
                .as_ref()
                .unwrap()
                .kind,
            "gradient"
        );
        assert_eq!(library.presets[0].document.frame.padding[2], 120.0);
        assert_eq!(fs::read(&path).unwrap(), before);
        let saved = save(&path, library, 7).unwrap();
        assert_eq!(saved.revision, 8);
        assert_eq!(load(&path).unwrap().presets[0].id, "mine");
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn version_two_migration_preserves_frame_documents_and_file_contents() {
        let dir = folder();
        let path = dir.join("beautify.json");
        let bytes = serde_json::to_vec(&serde_json::json!({"schema":2,"revision":9,"autoApply":true,
            "defaultPresetId":"wood","lastPresetId":"gallery","presets":[{"id":"mine","name":"Keep","document":document()}]})).unwrap();
        fs::write(&path, &bytes).unwrap();
        let library = load(&path).unwrap();
        assert_eq!(library.schema, 3);
        assert_eq!(library.revision, 9);
        assert_eq!(library.default_preset_id, "wood");
        assert_eq!(library.presets[0].document.frame.kind, "gradient");
        assert_eq!(fs::read(&path).unwrap(), bytes);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn retired_poster_settings_fall_back_to_frame_without_rewriting_on_load() {
        let dir = folder();
        let path = dir.join("beautify.json");
        let mut data = document();
        data["poster"] = serde_json::json!({"enabled":true,"title":"Legacy poster"});
        let bytes = serde_json::to_vec(
            &serde_json::json!({"schema":3,"revision":12,"autoApply":true,
            "defaultPresetId":"mine","lastPresetId":"mine",
            "presets":[{"id":"mine","name":"Keep my frame","document":data}]}),
        )
        .unwrap();
        fs::write(&path, &bytes).unwrap();
        let library = load(&path).unwrap();
        assert_eq!(library.revision, 12);
        assert_eq!(library.default_preset_id, "mine");
        assert!(library.auto_apply);
        assert_eq!(library.presets[0].document.frame.kind, "gradient");
        assert_eq!(library.presets[0].document.frame.padding[2], 120.0);
        assert_eq!(fs::read(&path).unwrap(), bytes);
        let saved = save(&path, library, 12).unwrap();
        let document = &serde_json::to_value(saved).unwrap()["presets"][0]["document"];
        assert!(document.get("poster").is_none());
        assert_eq!(document["frame"]["kind"], "gradient");
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn six_new_frame_types_validate_and_reject_invalid_style_fields() {
        let mut data = document();
        data["background"] = serde_json::json!({"kind":"gradient","color":"#e2eee6","endColor":"#bbd0c5","angle":125});
        data["frame"]["style"] = serde_json::json!({"title":"Window","url":"example.com","compact":false,
            "titleBarHeight":64,"railWidth":44,"matWidth":120,"matColor":"#f4f1e9","innerWidth":4,
            "accentColor":"#b6afa0","paperBottom":210,"caption":"Photo {date}","captionDate":true});
        for kind in [
            "mac-light",
            "mac-dark",
            "browser",
            "gallery",
            "wood",
            "polaroid",
        ] {
            data["frame"]["kind"] = kind.into();
            let context: EditContext =
                serde_json::from_value(serde_json::json!({"document":data,"capturedAt":1}))
                    .unwrap();
            assert!(context.validate().is_ok());
            let mut invalid = context.clone();
            invalid.document.frame.style.as_mut().unwrap().mat_width = -1.0;
            assert!(invalid.validate().is_err());
            let mut invalid = context.clone();
            invalid.document.frame.style.as_mut().unwrap().title = "x".repeat(301);
            assert!(invalid.validate().is_err());
            let mut library = Library::default();
            library.presets.push(model::Preset {
                id: kind.into(),
                name: "Reserved".into(),
                document: context.document,
            });
            assert!(library.validate().is_err());
        }
        data["background"]["color"] = "transparent".into();
        let context: EditContext =
            serde_json::from_value(serde_json::json!({"document":data,"capturedAt":1})).unwrap();
        assert!(context.validate().is_err());
    }
    fn folder() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "clover-beauty-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }
    #[test]
    fn library_rejects_unknown_schema_and_dangling_default_presets() {
        let mut library = Library::default();
        assert!(library.validate().is_ok());
        library.schema = 4;
        assert!(library.validate().is_err());
        library.schema = 3;
        library.default_preset_id = "missing".into();
        assert!(library.validate().is_err());
    }
    #[test]
    fn library_conflicts_and_failed_writes_preserve_previous_revision() {
        let dir = folder();
        let path = dir.join("beautify.json");
        let library = save(&path, Library::default(), 0).unwrap();
        assert_eq!(library.revision, 1);
        assert_eq!(
            save(&path, Library::default(), 0).unwrap_err(),
            "beautify.conflict"
        );
        assert_eq!(load(&path).unwrap().revision, 1);
        assert!(save(
            &dir.join("missing").join("data.json"),
            Library::default(),
            0
        )
        .is_err());
        fs::write(&path, b"broken").unwrap();
        assert!(load(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"broken");
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn imported_png_survives_source_removal_and_rejects_invalid_input() {
        let dir = folder();
        let source = dir.join("source.png");
        let assets = dir.join("assets");
        image::RgbaImage::new(2, 3).save(&source).unwrap();
        let id = import_asset(&source, &assets).unwrap();
        fs::remove_file(&source).unwrap();
        assert!(assets.join(format!("{id}.png")).exists());
        assert!(model::asset_id(&id));
        assert!(!model::asset_id("../config"));
        fs::write(&source, b"not png").unwrap();
        assert!(import_asset(&source, &assets).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
