use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::folder::validate_folder;
use crate::pty::lock;

/// The format version this app reads and writes in `projects.json`.
pub const FORMAT_VERSION: u64 = 1;

/// One project as stored in the file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Project {
    /// Unique within the file, never reused while the file lives.
    pub id: u32,
    /// The name of the project folder.
    pub name: String,
    /// The canonical path of the project folder, as it was when last chosen.
    pub path: String,
    /// The project's tabs; their shape belongs to the tab issues.
    #[serde(default)]
    pub tabs: Vec<serde_json::Value>,
}

/// The whole content of `projects.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectsFile {
    /// Always [`FORMAT_VERSION`] once loaded.
    pub version: u64,
    /// The projects, in the order they were added.
    pub projects: Vec<Project>,
    /// The smallest id a new project may take. Absent from older files: it
    /// then reads as 0 and the largest id plus one applies.
    #[serde(default)]
    pub next_id: u32,
}

impl Default for ProjectsFile {
    /// An empty list at the current format version.
    fn default() -> Self {
        Self {
            version: FORMAT_VERSION,
            projects: Vec::new(),
            next_id: 1,
        }
    }
}

/// One project as the webview receives it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProjectView {
    /// The project id.
    pub id: u32,
    /// The name of the project folder.
    pub name: String,
    /// The canonical path of the project folder.
    pub path: String,
    /// Whether that path still names a folder.
    pub exists: bool,
}

/// What `project_list` returns: the projects and the load warning, if any.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProjectList {
    /// Every project, in the order they were added.
    pub projects: Vec<ProjectView>,
    /// Set when the file could not be loaded and the app started with an empty list.
    pub warning: Option<String>,
}

/// The in-memory state guarded by the store's mutex.
#[derive(Debug)]
struct State {
    file: ProjectsFile,
    warning: Option<String>,
    read_only: bool,
}

/// The project list, owned by Rust and saved to a JSON file.
///
/// The file is read once, when the store opens; every change is written at once,
/// atomically. A second app instance working on the same file may lose a change
/// of the other one, never the file itself.
#[derive(Debug)]
pub struct ProjectStore {
    file: PathBuf,
    state: Mutex<State>,
}

/// What reading the file gave.
enum Loaded {
    Missing,
    Ready(ProjectsFile),
    Unreadable(String),
}

impl ProjectStore {
    /// Opens the store saved at `file`.
    ///
    /// A missing file gives an empty list. A file that cannot be read or parsed,
    /// or that has another format version, is copied aside (see
    /// [`unreadable_copy_path`]) and the store starts empty, with a warning
    /// returned by [`ProjectStore::list`]. When that copy fails too, the store
    /// also refuses every change until the app restarts, so the file is never
    /// overwritten.
    pub fn open(file: PathBuf) -> Self {
        let state = match load(&file) {
            Loaded::Missing => State {
                file: ProjectsFile::default(),
                warning: None,
                read_only: false,
            },
            Loaded::Ready(content) => State {
                file: content,
                warning: None,
                read_only: false,
            },
            Loaded::Unreadable(reason) => keep_aside(&file, &reason),
        };
        Self {
            file,
            state: Mutex::new(state),
        }
    }

    /// Lists every project, telling for each whether its folder still exists,
    /// with the load warning, if any.
    pub fn list(&self) -> ProjectList {
        let state = lock(&self.state);
        ProjectList {
            projects: state.file.projects.iter().map(view).collect(),
            warning: state.warning.clone(),
        }
    }

    /// Adds the folder at `folder` and returns its project.
    ///
    /// When a project already has that folder, under any spelling that resolves
    /// to the same canonical path, it is returned and nothing is added.
    ///
    /// # Errors
    /// A folder that is not absolute, missing or not a directory; a path the
    /// file cannot store; a read-only store; a failed save.
    pub fn add(&self, folder: &Path) -> Result<ProjectView, AppError> {
        let canonical = canonical_folder(folder)?;
        let mut state = lock(&self.state);
        if let Some(existing) = find_by_folder(&state.file, &canonical) {
            return Ok(view(existing));
        }
        let mut next = state.file.clone();
        let id = new_id(&next);
        next.next_id = id + 1;
        next.projects.push(Project {
            id,
            name: folder_name(&canonical),
            path: path_string(&canonical)?,
            tabs: Vec::new(),
        });
        self.commit(&mut state, next)?;
        Ok(view(state.file.projects.last().expect("just pushed")))
    }

    /// Moves project `id` to the folder at `folder`; its name follows the folder.
    ///
    /// # Errors
    /// An unknown id; a folder that is not absolute, missing or not a
    /// directory; a folder that already belongs to another project; a path the
    /// file cannot store; a read-only store; a failed save.
    pub fn relocate(&self, id: u32, folder: &Path) -> Result<ProjectView, AppError> {
        let canonical = canonical_folder(folder)?;
        let mut state = lock(&self.state);
        let index = position(&state.file, id)?;
        if let Some(other) = find_by_folder(&state.file, &canonical)
            && other.id != id
        {
            return Err(AppError::FolderTaken(other.name.clone()));
        }
        let mut next = state.file.clone();
        next.projects[index].name = folder_name(&canonical);
        next.projects[index].path = path_string(&canonical)?;
        self.commit(&mut state, next)?;
        Ok(view(&state.file.projects[index]))
    }

    /// Removes project `id`.
    ///
    /// # Errors
    /// An unknown id; a read-only store; a failed save.
    pub fn remove(&self, id: u32) -> Result<(), AppError> {
        let mut state = lock(&self.state);
        let index = position(&state.file, id)?;
        let mut next = state.file.clone();
        next.projects.remove(index);
        self.commit(&mut state, next)
    }

    /// Validates `raw`, a folder path sent by the webview, and returns its
    /// canonical form, only when it is the folder of a project.
    ///
    /// # Errors
    /// [`AppError::ProjectFolderMissing`] when `raw` is the stored path of a
    /// project whose folder no longer exists; the errors of
    /// [`validate_folder`]; [`AppError::FolderNotRegistered`] when the folder
    /// is no project's.
    pub fn spawn_folder(&self, raw: &str) -> Result<PathBuf, AppError> {
        let state = lock(&self.state);
        if let Some(project) = state.file.projects.iter().find(|p| p.path == raw)
            && !Path::new(&project.path).is_dir()
        {
            return Err(AppError::ProjectFolderMissing(project.name.clone()));
        }
        let canonical = validate_folder(raw)?;
        if find_by_folder(&state.file, &canonical).is_some() {
            Ok(canonical)
        } else {
            Err(AppError::FolderNotRegistered)
        }
    }

    /// Saves `next` to the file, then makes it the current list.
    ///
    /// # Errors
    /// [`AppError::ProjectsReadOnly`] or [`AppError::ProjectsNotSaved`]; the
    /// current list is then unchanged.
    fn commit(&self, state: &mut State, next: ProjectsFile) -> Result<(), AppError> {
        if state.read_only {
            return Err(AppError::ProjectsReadOnly);
        }
        write_atomically(&self.file, &next)
            .map_err(|error| AppError::ProjectsNotSaved(error.to_string()))?;
        state.file = next;
        Ok(())
    }
}

/// Reads and parses `file`.
fn load(file: &Path) -> Loaded {
    let text = match fs::read_to_string(file) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Loaded::Missing,
        Err(error) => return Loaded::Unreadable(format!("it could not be read: {error}")),
    };
    let value: serde_json::Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(error) => return Loaded::Unreadable(format!("it is not valid JSON: {error}")),
    };
    match value.get("version").and_then(serde_json::Value::as_u64) {
        Some(FORMAT_VERSION) => {}
        Some(other) => {
            return Loaded::Unreadable(format!(
                "it has format version {other}, this app reads version {FORMAT_VERSION}"
            ));
        }
        None => return Loaded::Unreadable("it has no format version".to_owned()),
    }
    match serde_json::from_value(value) {
        Ok(content) => Loaded::Ready(content),
        Err(error) => Loaded::Unreadable(format!("its content is not a project list: {error}")),
    }
}

/// Copies the unreadable `file` aside and returns the empty state to start
/// with, its warning telling why and where the copy is.
fn keep_aside(file: &Path, reason: &str) -> State {
    let copy = unreadable_copy_path(file);
    match fs::copy(file, &copy) {
        Ok(_) => State {
            file: ProjectsFile::default(),
            warning: Some(format!(
                "The project list could not be loaded ({reason}). It was copied to {} and the app started with an empty list.",
                copy.display()
            )),
            read_only: false,
        },
        Err(error) => State {
            file: ProjectsFile::default(),
            warning: Some(format!(
                "The project list could not be loaded ({reason}) and could not be copied aside ({error}). The app started with an empty list and will not save any change until it restarts, so {} is left as it is.",
                file.display()
            )),
            read_only: true,
        },
    }
}

/// Returns the first free name for the copy of an unreadable `file`:
/// `<name>.unreadable`, then `<name>.unreadable-2`, `<name>.unreadable-3`…
pub fn unreadable_copy_path(file: &Path) -> PathBuf {
    let base = format!(
        "{}.unreadable",
        file.file_name().unwrap_or_default().to_string_lossy()
    );
    let mut candidate = file.with_file_name(&base);
    let mut n = 2;
    while candidate.exists() {
        candidate = file.with_file_name(format!("{base}-{n}"));
        n += 1;
    }
    candidate
}

/// Writes `content` to `file` through a temporary file of the same folder,
/// renamed over `file` once flushed to disk. The folder is created if needed.
///
/// # Errors
/// Any I/O failure; the temporary file is then removed and `file` is untouched.
fn write_atomically(file: &Path, content: &ProjectsFile) -> io::Result<()> {
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = file.with_file_name(format!(
        "{}.{}.tmp",
        file.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id()
    ));
    let written = (|| {
        let mut out = fs::File::create(&temp)?;
        serde_json::to_writer_pretty(&mut out, content)?;
        out.write_all(b"\n")?;
        out.sync_all()?;
        drop(out);
        fs::rename(&temp, file)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&temp);
    }
    written
}

/// Returns the canonical form of `folder`, checked like a webview path.
///
/// # Errors
/// [`AppError::UnsupportedFolderPath`] for a path that is not valid Unicode;
/// the errors of [`validate_folder`].
fn canonical_folder(folder: &Path) -> Result<PathBuf, AppError> {
    validate_folder(folder.to_str().ok_or(AppError::UnsupportedFolderPath)?)
}

/// Returns `path` as a string.
///
/// # Errors
/// [`AppError::UnsupportedFolderPath`] for a path that is not valid Unicode.
fn path_string(path: &Path) -> Result<String, AppError> {
    path.to_str()
        .map(str::to_owned)
        .ok_or(AppError::UnsupportedFolderPath)
}

/// Returns the last component of `canonical`, or the whole path for a root.
fn folder_name(canonical: &Path) -> String {
    canonical.file_name().map_or_else(
        || canonical.display().to_string(),
        |name| name.to_string_lossy().into_owned(),
    )
}

/// Finds the project whose folder resolves to `canonical`. A stored path that
/// no longer resolves is compared as written.
fn find_by_folder<'a>(file: &'a ProjectsFile, canonical: &Path) -> Option<&'a Project> {
    file.projects.iter().find(|project| {
        let stored = Path::new(&project.path);
        dunce::canonicalize(stored).map_or_else(|_| stored == canonical, |c| c == canonical)
    })
}

/// Returns the id a new project takes in `file`: `next_id`, or the largest id
/// plus one when that is higher.
fn new_id(file: &ProjectsFile) -> u32 {
    let after_largest = file.projects.iter().map(|p| p.id).max().unwrap_or(0) + 1;
    file.next_id.max(after_largest)
}

/// Returns the index of project `id`.
///
/// # Errors
/// [`AppError::UnknownProject`].
fn position(file: &ProjectsFile, id: u32) -> Result<usize, AppError> {
    file.projects
        .iter()
        .position(|p| p.id == id)
        .ok_or(AppError::UnknownProject(id))
}

/// Returns what the webview receives for `project`.
fn view(project: &Project) -> ProjectView {
    ProjectView {
        id: project.id,
        name: project.name.clone(),
        path: project.path.clone(),
        exists: Path::new(&project.path).is_dir(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Opens a store on `projects.json` in `dir`.
    fn store_in(dir: &Path) -> ProjectStore {
        ProjectStore::open(dir.join("projects.json"))
    }

    /// Creates the folder `name` in `dir` and returns its canonical path.
    fn folder(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        fs::create_dir_all(&path).unwrap();
        dunce::canonicalize(path).unwrap()
    }

    /// Lists the file names in `dir`, sorted.
    fn names_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn a_missing_file_gives_an_empty_list_without_warning() {
        let dir = tempfile::tempdir().unwrap();
        let list = store_in(dir.path()).list();
        assert!(list.projects.is_empty());
        assert_eq!(list.warning, None);
    }

    #[test]
    fn projects_survive_a_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let alpha = folder(dir.path(), "alpha");
        let beta = folder(dir.path(), "beta");
        let store = store_in(dir.path());
        let a = store.add(&alpha).unwrap();
        let b = store.add(&beta).unwrap();
        assert_eq!((a.id, b.id), (1, 2));
        assert_eq!(a.name, "alpha");
        assert_eq!(a.path, alpha.to_str().unwrap());
        assert!(a.exists);

        let reopened = store_in(dir.path());
        assert_eq!(reopened.list(), store.list());
        let text = fs::read_to_string(dir.path().join("projects.json")).unwrap();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["version"], 1);
        assert_eq!(value["projects"][0]["tabs"], serde_json::json!([]));
    }

    #[test]
    fn two_spellings_of_one_folder_make_one_project() {
        let dir = tempfile::tempdir().unwrap();
        let alpha = folder(dir.path(), "alpha");
        folder(dir.path(), "alpha/child");
        let store = store_in(dir.path());
        let first = store.add(&alpha).unwrap();
        let second = store.add(&alpha.join("child").join("..")).unwrap();
        assert_eq!(first, second);
        assert_eq!(store.list().projects.len(), 1);
    }

    #[test]
    fn relocating_onto_another_projects_folder_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let alpha = folder(dir.path(), "alpha");
        let beta = folder(dir.path(), "beta");
        let store = store_in(dir.path());
        let a = store.add(&alpha).unwrap();
        store.add(&beta).unwrap();
        assert_eq!(
            store.relocate(a.id, &beta.join(".").join("..").join("beta")),
            Err(AppError::FolderTaken("beta".to_owned()))
        );
    }

    #[cfg(windows)]
    #[test]
    fn two_letter_cases_of_one_folder_make_one_project() {
        let dir = tempfile::tempdir().unwrap();
        let alpha = folder(dir.path(), "alpha");
        let shouted = PathBuf::from(alpha.to_str().unwrap().to_uppercase());
        let store = store_in(dir.path());
        let first = store.add(&alpha).unwrap();
        assert_eq!(store.add(&shouted).unwrap(), first);
        assert_eq!(store.list().projects.len(), 1);
        assert_eq!(store.spawn_folder(shouted.to_str().unwrap()), Ok(alpha));
    }

    #[test]
    fn adding_a_folder_that_does_not_exist_saves_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        assert_eq!(
            store.add(&dir.path().join("nowhere")),
            Err(AppError::FolderNotFound)
        );
        assert!(store.list().projects.is_empty());
        assert!(!dir.path().join("projects.json").exists());
    }

    #[test]
    fn relocating_onto_its_own_folder_under_another_spelling_keeps_the_project() {
        let dir = tempfile::tempdir().unwrap();
        let alpha = folder(dir.path(), "alpha");
        let store = store_in(dir.path());
        let a = store.add(&alpha).unwrap();
        assert_eq!(store.relocate(a.id, &alpha.join("..").join("alpha")), Ok(a));
    }

    #[test]
    fn relocating_a_project_whose_folder_is_gone_lets_it_start_again() {
        let dir = tempfile::tempdir().unwrap();
        let alpha = folder(dir.path(), "alpha");
        let store = store_in(dir.path());
        let a = store.add(&alpha).unwrap();
        fs::remove_dir(&alpha).unwrap();
        let moved_to = folder(dir.path(), "alpha-moved");

        let moved = store.relocate(a.id, &moved_to).unwrap();
        assert!(moved.exists);
        assert_eq!(store.spawn_folder(&moved.path), Ok(moved_to));
        assert_eq!(store.spawn_folder(&a.path), Err(AppError::FolderNotFound));
        assert_eq!(store_in(dir.path()).list(), store.list());
    }

    #[test]
    fn relocating_refuses_a_folder_that_does_not_exist() {
        let dir = tempfile::tempdir().unwrap();
        let alpha = folder(dir.path(), "alpha");
        let store = store_in(dir.path());
        let a = store.add(&alpha).unwrap();
        assert_eq!(
            store.relocate(a.id, &dir.path().join("nowhere")),
            Err(AppError::FolderNotFound)
        );
        assert_eq!(store.list().projects, [a]);
    }

    #[test]
    fn relocating_renames_the_project_after_its_folder() {
        let dir = tempfile::tempdir().unwrap();
        let alpha = folder(dir.path(), "alpha");
        let gamma = folder(dir.path(), "gamma");
        let store = store_in(dir.path());
        let a = store.add(&alpha).unwrap();
        let moved = store.relocate(a.id, &gamma).unwrap();
        assert_eq!(moved.id, a.id);
        assert_eq!(moved.name, "gamma");
        assert_eq!(moved.path, gamma.to_str().unwrap());
        assert_eq!(store.relocate(a.id, &gamma).unwrap(), moved);
        assert_eq!(
            store.relocate(99, &gamma),
            Err(AppError::UnknownProject(99))
        );
    }

    #[test]
    fn removing_a_project_forgets_it() {
        let dir = tempfile::tempdir().unwrap();
        let alpha = folder(dir.path(), "alpha");
        let store = store_in(dir.path());
        let a = store.add(&alpha).unwrap();
        store.remove(a.id).unwrap();
        assert!(store_in(dir.path()).list().projects.is_empty());
        assert_eq!(store.remove(a.id), Err(AppError::UnknownProject(a.id)));
    }

    #[test]
    fn spawn_refuses_a_folder_outside_the_list() {
        let dir = tempfile::tempdir().unwrap();
        let alpha = folder(dir.path(), "alpha");
        let other = folder(dir.path(), "other");
        let store = store_in(dir.path());
        store.add(&alpha).unwrap();
        assert_eq!(
            store.spawn_folder(other.to_str().unwrap()),
            Err(AppError::FolderNotRegistered)
        );
        let roundabout = alpha.join("..").join("alpha");
        assert_eq!(store.spawn_folder(roundabout.to_str().unwrap()), Ok(alpha));
    }

    #[test]
    fn spawn_names_the_project_whose_folder_is_gone() {
        let dir = tempfile::tempdir().unwrap();
        let alpha = folder(dir.path(), "alpha");
        let store = store_in(dir.path());
        let a = store.add(&alpha).unwrap();
        fs::remove_dir(&alpha).unwrap();
        assert!(!store.list().projects[0].exists);
        assert_eq!(
            store.spawn_folder(&a.path),
            Err(AppError::ProjectFolderMissing("alpha".to_owned()))
        );
    }

    #[test]
    fn a_corrupt_file_is_copied_aside_and_the_list_starts_empty() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("projects.json");
        fs::write(&file, "{ not json").unwrap();
        let store = store_in(dir.path());
        let list = store.list();
        assert!(list.projects.is_empty());
        let warning = list.warning.unwrap();
        assert!(warning.contains("projects.json.unreadable"), "{warning}");
        assert_eq!(
            fs::read_to_string(dir.path().join("projects.json.unreadable")).unwrap(),
            "{ not json"
        );

        store.add(&folder(dir.path(), "alpha")).unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join("projects.json.unreadable")).unwrap(),
            "{ not json"
        );
    }

    #[test]
    fn an_unknown_version_is_copied_aside_and_the_list_starts_empty() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("projects.json");
        let future = r#"{ "version": 2, "projects": [] }"#;
        fs::write(&file, future).unwrap();
        fs::write(dir.path().join("projects.json.unreadable"), "older").unwrap();
        let list = store_in(dir.path()).list();
        assert!(list.projects.is_empty());
        let warning = list.warning.unwrap();
        assert!(warning.contains("format version 2"), "{warning}");
        assert!(warning.contains("projects.json.unreadable-2"), "{warning}");
        assert_eq!(
            fs::read_to_string(dir.path().join("projects.json.unreadable-2")).unwrap(),
            future
        );
    }

    #[test]
    fn a_file_without_a_version_is_copied_aside_and_the_list_starts_empty() {
        let dir = tempfile::tempdir().unwrap();
        let unversioned = r#"{ "projects": [] }"#;
        fs::write(dir.path().join("projects.json"), unversioned).unwrap();
        let list = store_in(dir.path()).list();
        assert!(list.projects.is_empty());
        let warning = list.warning.unwrap();
        assert!(warning.contains("no format version"), "{warning}");
        assert_eq!(
            fs::read_to_string(dir.path().join("projects.json.unreadable")).unwrap(),
            unversioned
        );
    }

    #[test]
    fn a_file_whose_content_is_not_a_project_list_is_copied_aside() {
        let dir = tempfile::tempdir().unwrap();
        let malformed = r#"{ "version": 1, "projects": "alpha" }"#;
        fs::write(dir.path().join("projects.json"), malformed).unwrap();
        let list = store_in(dir.path()).list();
        assert!(list.projects.is_empty());
        let warning = list.warning.unwrap();
        assert!(warning.contains("not a project list"), "{warning}");
        assert_eq!(
            fs::read_to_string(dir.path().join("projects.json.unreadable")).unwrap(),
            malformed
        );
    }

    #[test]
    fn a_failed_save_leaves_the_previous_file_readable() {
        let dir = tempfile::tempdir().unwrap();
        let alpha = folder(dir.path(), "alpha");
        let beta = folder(dir.path(), "beta");
        let store = store_in(dir.path());
        store.add(&alpha).unwrap();
        let before = fs::read_to_string(dir.path().join("projects.json")).unwrap();
        let temp = dir
            .path()
            .join(format!("projects.json.{}.tmp", std::process::id()));
        fs::create_dir(&temp).unwrap();

        assert!(matches!(
            store.add(&beta),
            Err(AppError::ProjectsNotSaved(_))
        ));
        assert_eq!(
            fs::read_to_string(dir.path().join("projects.json")).unwrap(),
            before
        );
        assert_eq!(store.list().projects.len(), 1);
        let reopened = store_in(dir.path()).list();
        assert_eq!(reopened.warning, None);
        assert_eq!(reopened.projects, store.list().projects);
    }

    #[test]
    fn a_file_that_cannot_be_copied_aside_is_never_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("projects.json");
        fs::create_dir(&file).unwrap();
        fs::write(file.join("inside"), "kept").unwrap();
        let store = store_in(dir.path());
        let warning = store.list().warning.unwrap();
        assert!(warning.contains("could not be copied aside"), "{warning}");

        assert_eq!(
            store.add(&folder(dir.path(), "alpha")),
            Err(AppError::ProjectsReadOnly)
        );
        assert_eq!(fs::read_to_string(file.join("inside")).unwrap(), "kept");
    }

    #[test]
    fn a_save_leaves_no_temporary_file() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let alpha = folder(dir.path(), "alpha");
        let store = store_in(&data);
        store.add(&alpha).unwrap();
        store.remove(1).unwrap();
        assert_eq!(names_in(&data), ["projects.json"]);
    }

    #[test]
    fn a_failed_save_keeps_the_list_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let alpha = folder(dir.path(), "alpha");
        let blocker = dir.path().join("blocker");
        fs::write(&blocker, "").unwrap();
        let store = ProjectStore::open(blocker.join("projects.json"));
        assert!(matches!(
            store.add(&alpha),
            Err(AppError::ProjectsNotSaved(_))
        ));
        assert!(store.list().projects.is_empty());
    }

    #[test]
    fn ids_are_not_reused_after_a_removal_in_the_middle() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        store.add(&folder(dir.path(), "a")).unwrap();
        store.add(&folder(dir.path(), "b")).unwrap();
        store.remove(1).unwrap();
        assert_eq!(store.add(&folder(dir.path(), "c")).unwrap().id, 3);
    }

    #[test]
    fn ids_are_not_reused_after_removing_the_last_project() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        store.add(&folder(dir.path(), "a")).unwrap();
        store.add(&folder(dir.path(), "b")).unwrap();
        store.remove(2).unwrap();
        assert_eq!(
            store_in(dir.path())
                .add(&folder(dir.path(), "c"))
                .unwrap()
                .id,
            3
        );
    }

    #[test]
    fn a_file_without_next_id_takes_the_largest_id_plus_one() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("projects.json");
        let older = r#"{ "version": 1, "projects": [{ "id": 4, "name": "a", "path": "nowhere", "tabs": [] }] }"#;
        fs::write(&file, older).unwrap();
        let store = store_in(dir.path());
        assert_eq!(store.list().warning, None);
        assert_eq!(store.add(&folder(dir.path(), "b")).unwrap().id, 5);
        let text = fs::read_to_string(&file).unwrap();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["version"], 1);
        assert_eq!(value["next_id"], 6);
    }
}
