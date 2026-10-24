use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::folder::validate_folder;
use crate::pty::lock;
use crate::session::{LaunchMode, SessionId};

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
    /// The project's tabs, in the order they were opened.
    #[serde(default)]
    pub tabs: Vec<Tab>,
    /// The id of the project's last active tab. Absent from older files: it
    /// then reads as `None`. May name a tab that is gone; see [`active_tab`].
    #[serde(default)]
    pub active_tab: Option<u32>,
}

/// One tab as stored in the file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tab {
    /// At least 1, unique across every project of the file, never reused while
    /// the file lives.
    pub id: u32,
    /// The Claude Code session id the tab resumes.
    pub session_id: SessionId,
}

/// One tab as the webview receives it: its session id stays in Rust.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TabView {
    /// The tab id.
    pub id: u32,
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
    /// The smallest id a new tab may take, across every project. Absent from
    /// older files: it then reads as 0 and the largest tab id plus one applies.
    #[serde(default)]
    pub next_tab_id: u32,
    /// The id of the last selected project. Absent from older files: it then
    /// reads as `None`. May name a project that is gone; see [`selection`].
    #[serde(default)]
    pub selected: Option<u32>,
}

impl Default for ProjectsFile {
    /// An empty list at the current format version.
    fn default() -> Self {
        Self {
            version: FORMAT_VERSION,
            projects: Vec::new(),
            next_id: 1,
            next_tab_id: 1,
            selected: None,
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
    /// The project's tabs, in the order they were opened.
    pub tabs: Vec<TabView>,
    /// The tab to bring to the front: the last active one while it exists,
    /// else the first tab, else `None` when the project has no tab.
    #[serde(rename = "activeTab")]
    pub active_tab: Option<u32>,
}

/// What `project_list` returns: the projects and the load warning, if any.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProjectList {
    /// Every project, in the order they were added.
    pub projects: Vec<ProjectView>,
    /// Set when the file could not be loaded and the app started with an empty list.
    pub warning: Option<String>,
    /// The project to select: the last selected one while it exists, else the
    /// first project, else `None` when there is no project.
    pub selected: Option<u32>,
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
/// atomically. The store must be the only writer of its file: a second store on
/// the same file may lose a change of the other one, never the file itself. The
/// app runs a single instance, so it opens one store only.
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
            selected: selection(&state.file),
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
            active_tab: None,
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

    /// Removes project `id`, with its tabs.
    ///
    /// When it was the selected project, the selection moves, in the same
    /// save, to the project that takes its place in the list, else to the one
    /// before it, else to none.
    ///
    /// # Errors
    /// An unknown id; a read-only store; a failed save.
    pub fn remove(&self, id: u32) -> Result<(), AppError> {
        let mut state = lock(&self.state);
        let index = position(&state.file, id)?;
        let mut next = state.file.clone();
        next.projects.remove(index);
        if next.selected == Some(id) {
            next.selected = next
                .projects
                .get(index)
                .or_else(|| {
                    index
                        .checked_sub(1)
                        .and_then(|before| next.projects.get(before))
                })
                .map(|neighbour| neighbour.id);
        }
        self.commit(&mut state, next)
    }

    /// Remembers project `id` as the selected one and saves it. Writes nothing
    /// when it already is. On a read-only store the selection is kept in
    /// memory only, and no error is returned.
    ///
    /// # Errors
    /// An unknown id; a failed save.
    pub fn select(&self, id: u32) -> Result<(), AppError> {
        let mut state = lock(&self.state);
        position(&state.file, id)?;
        if state.file.selected == Some(id) {
            return Ok(());
        }
        if state.read_only {
            state.file.selected = Some(id);
            return Ok(());
        }
        let mut next = state.file.clone();
        next.selected = Some(id);
        self.commit(&mut state, next)
    }

    /// Opens a new tab in project `project`, with a new session id, and returns
    /// it. The new tab becomes the project's active tab, in the same save.
    ///
    /// # Errors
    /// An unknown project id; a read-only store; a failed save.
    pub fn open_tab(&self, project: u32) -> Result<TabView, AppError> {
        let mut state = lock(&self.state);
        let index = position(&state.file, project)?;
        let mut next = state.file.clone();
        let id = new_tab_id(&next);
        next.next_tab_id = id + 1;
        next.projects[index].tabs.push(Tab {
            id,
            session_id: SessionId::generate(),
        });
        next.projects[index].active_tab = Some(id);
        self.commit(&mut state, next)?;
        Ok(TabView { id })
    }

    /// Closes tab `tab`: it is removed from its project.
    ///
    /// When it was the project's active tab, the active tab moves, in the same
    /// save, to the tab that takes its place, else to the one before it, else
    /// to none.
    ///
    /// # Errors
    /// [`AppError::UnknownTab`]; a read-only store; a failed save.
    pub fn close_tab(&self, tab: u32) -> Result<(), AppError> {
        let mut state = lock(&self.state);
        let (project, index) = tab_position(&state.file, tab)?;
        let mut next = state.file.clone();
        let owner = &mut next.projects[project];
        owner.tabs.remove(index);
        if owner.active_tab == Some(tab) {
            owner.active_tab = owner
                .tabs
                .get(index)
                .or_else(|| {
                    index
                        .checked_sub(1)
                        .and_then(|before| owner.tabs.get(before))
                })
                .map(|neighbour| neighbour.id);
        }
        self.commit(&mut state, next)
    }

    /// Remembers tab `tab` as the active tab of its project and saves it.
    /// Writes nothing when it already is. On a read-only store the active tab
    /// is kept in memory only, and no error is returned.
    ///
    /// # Errors
    /// [`AppError::UnknownTab`]; a failed save.
    pub fn activate_tab(&self, tab: u32) -> Result<(), AppError> {
        let mut state = lock(&self.state);
        let (project, _) = tab_position(&state.file, tab)?;
        if state.file.projects[project].active_tab == Some(tab) {
            return Ok(());
        }
        if state.read_only {
            state.file.projects[project].active_tab = Some(tab);
            return Ok(());
        }
        let mut next = state.file.clone();
        next.projects[project].active_tab = Some(tab);
        self.commit(&mut state, next)
    }

    /// Returns the canonical folder and the session id to start tab `tab` with.
    ///
    /// For [`LaunchMode::New`] a new session id is generated and saved before it
    /// is returned; for [`LaunchMode::Resume`] the stored one is returned.
    ///
    /// # Errors
    /// [`AppError::UnknownTab`]; [`AppError::ProjectFolderMissing`] when the
    /// project's folder no longer exists; the errors of [`validate_folder`];
    /// [`AppError::FolderNotRegistered`] when the folder no longer resolves to
    /// this project; for a new session, a read-only store or a failed save.
    pub fn launch(&self, tab: u32, mode: LaunchMode) -> Result<(PathBuf, SessionId), AppError> {
        let mut state = lock(&self.state);
        let (project, index) = tab_position(&state.file, tab)?;
        let folder = spawn_folder(&state.file, &state.file.projects[project].path)?;
        match mode {
            LaunchMode::Resume => Ok((
                folder,
                state.file.projects[project].tabs[index].session_id.clone(),
            )),
            LaunchMode::New => {
                let session_id = SessionId::generate();
                let mut next = state.file.clone();
                next.projects[project].tabs[index].session_id = session_id.clone();
                self.commit(&mut state, next)?;
                Ok((folder, session_id))
            }
        }
    }

    /// Makes `session_id` the session id of tab `tab`. Does nothing when no
    /// tab has that id or when it already has that session id.
    ///
    /// # Errors
    /// A read-only store; a failed save.
    pub fn set_session(&self, tab: u32, session_id: SessionId) -> Result<(), AppError> {
        let mut state = lock(&self.state);
        let Ok((project, index)) = tab_position(&state.file, tab) else {
            return Ok(());
        };
        if state.file.projects[project].tabs[index].session_id == session_id {
            return Ok(());
        }
        let mut next = state.file.clone();
        next.projects[project].tabs[index].session_id = session_id;
        self.commit(&mut state, next)
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
    let content: ProjectsFile = match serde_json::from_value(value) {
        Ok(content) => content,
        Err(error) => {
            return Loaded::Unreadable(format!("its content is not a project list: {error}"));
        }
    };
    match invalid_tab(&content) {
        Some(id) => Loaded::Unreadable(format!("it has a tab id of 0 or used twice: {id}")),
        None => Loaded::Ready(content),
    }
}

/// Returns the first tab id of `file` that is 0 or already used by an earlier
/// tab of any project, or `None` when every tab id is valid.
fn invalid_tab(file: &ProjectsFile) -> Option<u32> {
    let mut seen = std::collections::HashSet::new();
    file.projects
        .iter()
        .flat_map(|project| &project.tabs)
        .map(|tab| tab.id)
        .find(|&id| id == 0 || !seen.insert(id))
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

/// Writes `content` as indented JSON to `file`, with [`write_file_atomically`].
///
/// # Errors
/// Any I/O failure; `file` is then untouched.
fn write_atomically(file: &Path, content: &ProjectsFile) -> io::Result<()> {
    let mut bytes = serde_json::to_vec_pretty(content)?;
    bytes.push(b'\n');
    write_file_atomically(file, &bytes)
}

/// Writes `bytes` to `file` through the temporary file
/// `<name>.<process id>.tmp` of the same folder, renamed over `file` once
/// flushed to disk. The folder is created if needed.
///
/// # Errors
/// Any I/O failure; the temporary file is then removed and `file` is untouched.
pub(crate) fn write_file_atomically(file: &Path, bytes: &[u8]) -> io::Result<()> {
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
        out.write_all(bytes)?;
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

/// Returns the id a new tab takes in `file`: `next_tab_id`, or the largest
/// tab id of any project plus one when that is higher.
fn new_tab_id(file: &ProjectsFile) -> u32 {
    let after_largest = file
        .projects
        .iter()
        .flat_map(|project| &project.tabs)
        .map(|tab| tab.id)
        .max()
        .unwrap_or(0)
        + 1;
    file.next_tab_id.max(after_largest)
}

/// Returns the index of the project holding tab `tab`, and the tab's index in it.
///
/// # Errors
/// [`AppError::UnknownTab`].
fn tab_position(file: &ProjectsFile, tab: u32) -> Result<(usize, usize), AppError> {
    file.projects
        .iter()
        .enumerate()
        .find_map(|(project, p)| {
            p.tabs
                .iter()
                .position(|t| t.id == tab)
                .map(|index| (project, index))
        })
        .ok_or(AppError::UnknownTab(tab))
}

/// Validates `raw`, the stored folder path of a project of `file`, and returns
/// its canonical form, only when it is still the folder of a project.
///
/// # Errors
/// [`AppError::ProjectFolderMissing`] when `raw` is the stored path of a
/// project whose folder no longer exists; the errors of [`validate_folder`];
/// [`AppError::FolderNotRegistered`] when the folder is no project's.
fn spawn_folder(file: &ProjectsFile, raw: &str) -> Result<PathBuf, AppError> {
    if let Some(project) = file.projects.iter().find(|p| p.path == raw)
        && !Path::new(&project.path).is_dir()
    {
        return Err(AppError::ProjectFolderMissing(project.name.clone()));
    }
    let canonical = validate_folder(raw)?;
    if find_by_folder(file, &canonical).is_some() {
        Ok(canonical)
    } else {
        Err(AppError::FolderNotRegistered)
    }
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

/// Returns the project to select in `file`: the stored selection while it
/// names a project, else the first project, else `None`.
fn selection(file: &ProjectsFile) -> Option<u32> {
    file.selected
        .filter(|id| position(file, *id).is_ok())
        .or_else(|| file.projects.first().map(|project| project.id))
}

/// Returns the tab to bring to the front in `project`: the stored active tab
/// while it names a tab of the project, else the first tab, else `None`.
fn active_tab(project: &Project) -> Option<u32> {
    project
        .active_tab
        .filter(|id| project.tabs.iter().any(|tab| tab.id == *id))
        .or_else(|| project.tabs.first().map(|tab| tab.id))
}

/// Returns what the webview receives for `project`.
fn view(project: &Project) -> ProjectView {
    ProjectView {
        id: project.id,
        name: project.name.clone(),
        path: project.path.clone(),
        exists: Path::new(&project.path).is_dir(),
        tabs: project
            .tabs
            .iter()
            .map(|tab| TabView { id: tab.id })
            .collect(),
        active_tab: active_tab(project),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Checks `raw` against the project list of `store`, as a launch does.
    fn spawn_folder_of(store: &ProjectStore, raw: &str) -> Result<PathBuf, AppError> {
        spawn_folder(&lock(&store.state).file, raw)
    }

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
        assert_eq!(
            spawn_folder_of(&store, shouted.to_str().unwrap()),
            Ok(alpha)
        );
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
        assert_eq!(spawn_folder_of(&store, &moved.path), Ok(moved_to));
        assert_eq!(
            spawn_folder_of(&store, &a.path),
            Err(AppError::FolderNotFound)
        );
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
            spawn_folder_of(&store, other.to_str().unwrap()),
            Err(AppError::FolderNotRegistered)
        );
        let roundabout = alpha.join("..").join("alpha");
        assert_eq!(
            spawn_folder_of(&store, roundabout.to_str().unwrap()),
            Ok(alpha)
        );
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
            spawn_folder_of(&store, &a.path),
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

    /// The session id stored for tab `tab` of `store`.
    fn session_of(store: &ProjectStore, tab: u32) -> SessionId {
        let state = lock(&store.state);
        let (project, index) = tab_position(&state.file, tab).unwrap();
        state.file.projects[project].tabs[index].session_id.clone()
    }

    #[test]
    fn tab_ids_are_global_and_never_reused() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        let a = store.add(&folder(dir.path(), "a")).unwrap();
        let b = store.add(&folder(dir.path(), "b")).unwrap();
        assert_eq!(store.open_tab(a.id).unwrap().id, 1);
        assert_eq!(store.open_tab(b.id).unwrap().id, 2);
        assert_eq!(store.open_tab(a.id).unwrap().id, 3);
        store.close_tab(3).unwrap();
        assert_eq!(store.open_tab(a.id).unwrap().id, 4);
        store.remove(b.id).unwrap();
        let reopened = store_in(dir.path());
        assert_eq!(reopened.open_tab(a.id).unwrap().id, 5);
        let tabs: Vec<u32> = reopened.list().projects[0]
            .tabs
            .iter()
            .map(|t| t.id)
            .collect();
        assert_eq!(tabs, [1, 4, 5]);
        assert_eq!(store.open_tab(99), Err(AppError::UnknownProject(99)));
    }

    #[test]
    fn tabs_survive_a_reopen_with_their_session_id() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        let a = store.add(&folder(dir.path(), "a")).unwrap();
        let tab = store.open_tab(a.id).unwrap();
        let reopened = store_in(dir.path());
        assert_eq!(session_of(&reopened, tab.id), session_of(&store, tab.id));
        let text = fs::read_to_string(dir.path().join("projects.json")).unwrap();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["next_tab_id"], 2);
        assert_eq!(value["projects"][0]["tabs"][0]["id"], 1);
        assert_eq!(
            value["projects"][0]["tabs"][0]["session_id"],
            session_of(&store, tab.id).as_str()
        );
    }

    #[test]
    fn the_webview_never_sees_a_session_id() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        let a = store.add(&folder(dir.path(), "a")).unwrap();
        let tab = store.open_tab(a.id).unwrap();
        assert_eq!(
            serde_json::to_value(&tab).unwrap(),
            serde_json::json!({ "id": 1 })
        );
        let listed = serde_json::to_value(store.list()).unwrap();
        assert_eq!(
            listed["projects"][0]["tabs"],
            serde_json::json!([{ "id": 1 }])
        );
    }

    #[test]
    fn a_file_without_next_tab_id_takes_the_largest_tab_id_plus_one() {
        let dir = tempfile::tempdir().unwrap();
        let alpha = folder(dir.path(), "alpha");
        let file = dir.path().join("projects.json");
        let older = serde_json::json!({
            "version": 1,
            "projects": [
                { "id": 1, "name": "alpha", "path": alpha.to_str().unwrap(), "tabs": [] },
                { "id": 2, "name": "gone", "path": "nowhere",
                  "tabs": [{ "id": 4, "session_id": "0f8e5c1a-3b2d-4c6e-9a7f-1d2c3b4a5e6f" }] }
            ]
        });
        fs::write(&file, older.to_string()).unwrap();
        let store = store_in(dir.path());
        assert_eq!(store.list().warning, None);
        assert_eq!(store.open_tab(1).unwrap().id, 5);
        let value: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(value["next_tab_id"], 6);
    }

    #[test]
    fn an_invalid_tab_makes_the_file_unreadable() {
        let session = "0f8e5c1a-3b2d-4c6e-9a7f-1d2c3b4a5e6f";
        for tabs in [
            serde_json::json!([{ "id": 0, "session_id": session }]),
            serde_json::json!([{ "id": 3, "session_id": session }, { "id": 3, "session_id": session }]),
            serde_json::json!([{ "id": 3, "session_id": "-x" }]),
            serde_json::json!([{ "id": 3 }]),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let content = serde_json::json!({
                "version": 1,
                "projects": [{ "id": 1, "name": "a", "path": "nowhere", "tabs": tabs }]
            })
            .to_string();
            fs::write(dir.path().join("projects.json"), &content).unwrap();
            let list = store_in(dir.path()).list();
            assert!(list.projects.is_empty(), "{content}");
            assert!(list.warning.is_some(), "{content}");
            assert_eq!(
                fs::read_to_string(dir.path().join("projects.json.unreadable")).unwrap(),
                content
            );
        }
    }

    #[test]
    fn a_tab_id_used_by_two_projects_makes_the_file_unreadable() {
        let session = "0f8e5c1a-3b2d-4c6e-9a7f-1d2c3b4a5e6f";
        let dir = tempfile::tempdir().unwrap();
        let content = serde_json::json!({
            "version": 1,
            "projects": [
                { "id": 1, "name": "a", "path": "nowhere", "tabs": [{ "id": 2, "session_id": session }] },
                { "id": 2, "name": "b", "path": "elsewhere", "tabs": [{ "id": 2, "session_id": session }] }
            ]
        })
        .to_string();
        fs::write(dir.path().join("projects.json"), &content).unwrap();
        let warning = store_in(dir.path()).list().warning.unwrap();
        assert!(
            warning.contains("tab id of 0 or used twice: 2"),
            "{warning}"
        );
    }

    #[test]
    fn a_new_launch_saves_a_new_session_id_and_resume_keeps_it() {
        let dir = tempfile::tempdir().unwrap();
        let alpha = folder(dir.path(), "alpha");
        let store = store_in(dir.path());
        let a = store.add(&alpha).unwrap();
        let tab = store.open_tab(a.id).unwrap().id;
        let opened_with = session_of(&store, tab);

        let (folder_new, new) = store.launch(tab, LaunchMode::New).unwrap();
        assert_eq!(folder_new, alpha);
        assert_ne!(new, opened_with);
        assert_eq!(session_of(&store_in(dir.path()), tab), new);

        let (folder_resumed, resumed) = store.launch(tab, LaunchMode::Resume).unwrap();
        assert_eq!(folder_resumed, alpha);
        assert_eq!(resumed, new);
    }

    #[test]
    fn launching_refuses_an_unknown_tab_or_a_missing_folder() {
        let dir = tempfile::tempdir().unwrap();
        let alpha = folder(dir.path(), "alpha");
        let store = store_in(dir.path());
        let a = store.add(&alpha).unwrap();
        let tab = store.open_tab(a.id).unwrap().id;
        assert_eq!(
            store.launch(7, LaunchMode::Resume),
            Err(AppError::UnknownTab(7))
        );
        fs::remove_dir(&alpha).unwrap();
        let before = session_of(&store, tab);
        assert_eq!(
            store.launch(tab, LaunchMode::New),
            Err(AppError::ProjectFolderMissing("alpha".to_owned()))
        );
        assert_eq!(session_of(&store, tab), before);
    }

    #[test]
    fn closing_a_tab_or_removing_its_project_forgets_it() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        let a = store.add(&folder(dir.path(), "a")).unwrap();
        let first = store.open_tab(a.id).unwrap().id;
        let second = store.open_tab(a.id).unwrap().id;
        store.close_tab(first).unwrap();
        assert_eq!(store.close_tab(first), Err(AppError::UnknownTab(first)));
        store.remove(a.id).unwrap();
        assert_eq!(
            store.launch(second, LaunchMode::Resume),
            Err(AppError::UnknownTab(second))
        );
    }

    /// The `selected` field saved in the `projects.json` of `dir`.
    fn saved_selection(dir: &Path) -> serde_json::Value {
        let text = fs::read_to_string(dir.join("projects.json")).unwrap();
        serde_json::from_str::<serde_json::Value>(&text).unwrap()["selected"].clone()
    }

    #[test]
    fn the_selection_survives_a_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        store.add(&folder(dir.path(), "a")).unwrap();
        let b = store.add(&folder(dir.path(), "b")).unwrap();
        assert_eq!(store.list().selected, Some(1));
        store.select(b.id).unwrap();
        assert_eq!(store.list().selected, Some(b.id));
        assert_eq!(store_in(dir.path()).list().selected, Some(b.id));
        assert_eq!(saved_selection(dir.path()), b.id);
    }

    #[test]
    fn selecting_an_unknown_project_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        let a = store.add(&folder(dir.path(), "a")).unwrap();
        store.select(a.id).unwrap();
        assert_eq!(store.select(9), Err(AppError::UnknownProject(9)));
        assert_eq!(store.list().selected, Some(a.id));
    }

    #[test]
    fn selecting_the_selected_project_again_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        let a = store.add(&folder(dir.path(), "a")).unwrap();
        store.select(a.id).unwrap();
        let file = dir.path().join("projects.json");
        fs::remove_file(&file).unwrap();
        assert_eq!(store.select(a.id), Ok(()));
        assert!(!file.exists());
    }

    #[test]
    fn the_list_resolves_the_selection() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        assert_eq!(store.list().selected, None);
        let a = store.add(&folder(dir.path(), "a")).unwrap();
        assert_eq!(store.list().selected, Some(a.id));
        lock(&store.state).file.selected = Some(42);
        assert_eq!(store.list().selected, Some(a.id));
    }

    #[test]
    fn removing_the_selected_project_selects_its_neighbour() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        let a = store.add(&folder(dir.path(), "a")).unwrap();
        let b = store.add(&folder(dir.path(), "b")).unwrap();
        let c = store.add(&folder(dir.path(), "c")).unwrap();

        store.select(b.id).unwrap();
        store.remove(b.id).unwrap();
        assert_eq!(store.list().selected, Some(c.id));
        assert_eq!(saved_selection(dir.path()), c.id);

        store.remove(c.id).unwrap();
        assert_eq!(store.list().selected, Some(a.id));
        assert_eq!(saved_selection(dir.path()), a.id);

        store.remove(a.id).unwrap();
        assert_eq!(store.list().selected, None);
        assert_eq!(saved_selection(dir.path()), serde_json::Value::Null);
    }

    #[test]
    fn removing_another_project_keeps_the_selection() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        let a = store.add(&folder(dir.path(), "a")).unwrap();
        let b = store.add(&folder(dir.path(), "b")).unwrap();
        store.select(b.id).unwrap();
        store.remove(a.id).unwrap();
        assert_eq!(saved_selection(dir.path()), b.id);
    }

    #[test]
    fn a_read_only_store_keeps_the_selection_in_memory() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("projects.json");
        fs::create_dir(&file).unwrap();
        let store = store_in(dir.path());
        lock(&store.state).file.projects = vec![
            Project {
                id: 1,
                name: "a".to_owned(),
                path: "nowhere".to_owned(),
                tabs: Vec::new(),
                active_tab: None,
            },
            Project {
                id: 2,
                name: "b".to_owned(),
                path: "elsewhere".to_owned(),
                tabs: Vec::new(),
                active_tab: None,
            },
        ];
        assert_eq!(store.select(2), Ok(()));
        assert_eq!(store.list().selected, Some(2));
        assert!(names_in(&file).is_empty());
    }

    #[test]
    fn a_file_without_selected_selects_the_first_project() {
        let dir = tempfile::tempdir().unwrap();
        let older = r#"{ "version": 1, "projects": [{ "id": 4, "name": "a", "path": "nowhere", "tabs": [] }, { "id": 7, "name": "b", "path": "elsewhere", "tabs": [] }] }"#;
        fs::write(dir.path().join("projects.json"), older).unwrap();
        let list = store_in(dir.path()).list();
        assert_eq!(list.warning, None);
        assert_eq!(list.selected, Some(4));
    }

    #[test]
    fn a_saved_selection_of_a_gone_project_selects_the_first_project() {
        let dir = tempfile::tempdir().unwrap();
        let saved = r#"{ "version": 1, "selected": 9, "projects": [{ "id": 4, "name": "a", "path": "nowhere", "tabs": [] }, { "id": 7, "name": "b", "path": "elsewhere", "tabs": [] }] }"#;
        fs::write(dir.path().join("projects.json"), saved).unwrap();
        assert_eq!(store_in(dir.path()).list().selected, Some(4));
    }

    #[test]
    fn removing_the_selected_first_project_selects_the_next_one() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        let a = store.add(&folder(dir.path(), "a")).unwrap();
        let b = store.add(&folder(dir.path(), "b")).unwrap();
        store.add(&folder(dir.path(), "c")).unwrap();
        store.select(a.id).unwrap();
        store.remove(a.id).unwrap();
        assert_eq!(saved_selection(dir.path()), b.id);
    }

    #[test]
    fn selecting_an_unknown_project_on_a_read_only_store_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("projects.json")).unwrap();
        let store = store_in(dir.path());
        lock(&store.state).file.projects = vec![Project {
            id: 1,
            name: "a".to_owned(),
            path: "nowhere".to_owned(),
            tabs: Vec::new(),
            active_tab: None,
        }];
        assert_eq!(store.select(5), Err(AppError::UnknownProject(5)));
        assert_eq!(store.list().selected, Some(1));
    }

    #[test]
    fn setting_a_session_of_an_unknown_tab_does_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        assert_eq!(store.set_session(3, SessionId::generate()), Ok(()));
        assert!(!dir.path().join("projects.json").exists());
    }

    /// The `active_tab` field of the first project saved in the
    /// `projects.json` of `dir`.
    fn saved_active_tab(dir: &Path) -> serde_json::Value {
        let text = fs::read_to_string(dir.join("projects.json")).unwrap();
        serde_json::from_str::<serde_json::Value>(&text).unwrap()["projects"][0]["active_tab"]
            .clone()
    }

    /// The active tab `store` lists for project `id`.
    fn listed_active_tab(store: &ProjectStore, id: u32) -> Option<u32> {
        store
            .list()
            .projects
            .into_iter()
            .find(|project| project.id == id)
            .unwrap()
            .active_tab
    }

    #[test]
    fn the_active_tab_survives_a_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        let a = store.add(&folder(dir.path(), "a")).unwrap();
        let first = store.open_tab(a.id).unwrap().id;
        store.open_tab(a.id).unwrap();
        let third = store.open_tab(a.id).unwrap().id;
        store.activate_tab(first).unwrap();
        store.activate_tab(third).unwrap();
        assert_eq!(listed_active_tab(&store_in(dir.path()), a.id), Some(third));
        assert_eq!(saved_active_tab(dir.path()), third);
    }

    #[test]
    fn opening_a_tab_makes_it_active() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        let a = store.add(&folder(dir.path(), "a")).unwrap();
        assert_eq!(listed_active_tab(&store, a.id), None);
        store.open_tab(a.id).unwrap();
        let second = store.open_tab(a.id).unwrap().id;
        assert_eq!(listed_active_tab(&store, a.id), Some(second));
        assert_eq!(saved_active_tab(dir.path()), second);
    }

    #[test]
    fn closing_the_active_tab_activates_its_neighbour() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        let a = store.add(&folder(dir.path(), "a")).unwrap();
        let first = store.open_tab(a.id).unwrap().id;
        let second = store.open_tab(a.id).unwrap().id;
        let third = store.open_tab(a.id).unwrap().id;

        store.activate_tab(second).unwrap();
        store.close_tab(second).unwrap();
        assert_eq!(saved_active_tab(dir.path()), third);

        store.close_tab(third).unwrap();
        assert_eq!(saved_active_tab(dir.path()), first);

        store.close_tab(first).unwrap();
        assert_eq!(saved_active_tab(dir.path()), serde_json::Value::Null);
        assert_eq!(listed_active_tab(&store, a.id), None);
    }

    #[test]
    fn closing_another_tab_keeps_the_active_tab() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        let a = store.add(&folder(dir.path(), "a")).unwrap();
        let first = store.open_tab(a.id).unwrap().id;
        let second = store.open_tab(a.id).unwrap().id;
        store.close_tab(first).unwrap();
        assert_eq!(saved_active_tab(dir.path()), second);
    }

    #[test]
    fn activating_an_unknown_tab_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        let a = store.add(&folder(dir.path(), "a")).unwrap();
        let tab = store.open_tab(a.id).unwrap().id;
        assert_eq!(store.activate_tab(9), Err(AppError::UnknownTab(9)));
        assert_eq!(listed_active_tab(&store, a.id), Some(tab));
    }

    #[test]
    fn activating_the_active_tab_again_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        let a = store.add(&folder(dir.path(), "a")).unwrap();
        let tab = store.open_tab(a.id).unwrap().id;
        let file = dir.path().join("projects.json");
        fs::remove_file(&file).unwrap();
        assert_eq!(store.activate_tab(tab), Ok(()));
        assert!(!file.exists());
    }

    #[test]
    fn a_read_only_store_keeps_the_active_tab_in_memory() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("projects.json");
        fs::create_dir(&file).unwrap();
        let store = store_in(dir.path());
        let tab = |id| Tab {
            id,
            session_id: SessionId::generate(),
        };
        lock(&store.state).file.projects = vec![Project {
            id: 1,
            name: "a".to_owned(),
            path: "nowhere".to_owned(),
            tabs: vec![tab(1), tab(2)],
            active_tab: None,
        }];
        assert_eq!(store.activate_tab(2), Ok(()));
        assert_eq!(listed_active_tab(&store, 1), Some(2));
        assert!(names_in(&file).is_empty());
    }

    #[test]
    fn a_saved_active_tab_that_is_gone_activates_the_first_tab() {
        let dir = tempfile::tempdir().unwrap();
        let saved = r#"{ "version": 1, "projects": [{ "id": 4, "name": "a", "path": "nowhere", "active_tab": 9, "tabs": [{ "id": 2, "session_id": "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b" }, { "id": 3, "session_id": "7f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b" }] }] }"#;
        fs::write(dir.path().join("projects.json"), saved).unwrap();
        let store = store_in(dir.path());
        assert_eq!(store.list().warning, None);
        assert_eq!(listed_active_tab(&store, 4), Some(2));
    }

    #[test]
    fn a_file_without_active_tab_activates_each_first_tab() {
        let dir = tempfile::tempdir().unwrap();
        let older = r#"{ "version": 1, "projects": [{ "id": 4, "name": "a", "path": "nowhere", "tabs": [{ "id": 2, "session_id": "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b" }, { "id": 3, "session_id": "7f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b" }] }, { "id": 7, "name": "b", "path": "elsewhere", "tabs": [{ "id": 5, "session_id": "8f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b" }] }] }"#;
        fs::write(dir.path().join("projects.json"), older).unwrap();
        let store = store_in(dir.path());
        assert_eq!(store.list().warning, None);
        assert_eq!(listed_active_tab(&store, 4), Some(2));
        assert_eq!(listed_active_tab(&store, 7), Some(5));
    }

    #[test]
    fn closing_a_tab_after_the_active_one_keeps_the_active_tab() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        let a = store.add(&folder(dir.path(), "a")).unwrap();
        let first = store.open_tab(a.id).unwrap().id;
        let second = store.open_tab(a.id).unwrap().id;
        store.open_tab(a.id).unwrap();
        store.activate_tab(first).unwrap();
        store.close_tab(second).unwrap();
        assert_eq!(saved_active_tab(dir.path()), first);
    }

    #[test]
    fn activating_a_tab_changes_only_its_own_project() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        let a = store.add(&folder(dir.path(), "a")).unwrap();
        let b = store.add(&folder(dir.path(), "b")).unwrap();
        let a_first = store.open_tab(a.id).unwrap().id;
        store.open_tab(a.id).unwrap();
        let b_first = store.open_tab(b.id).unwrap().id;
        store.open_tab(b.id).unwrap();

        store.activate_tab(b_first).unwrap();
        store.activate_tab(a_first).unwrap();

        let reopened = store_in(dir.path());
        assert_eq!(listed_active_tab(&reopened, a.id), Some(a_first));
        assert_eq!(listed_active_tab(&reopened, b.id), Some(b_first));
    }

    #[test]
    fn closing_the_active_tab_of_one_project_keeps_the_other_project_s() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        let a = store.add(&folder(dir.path(), "a")).unwrap();
        let b = store.add(&folder(dir.path(), "b")).unwrap();
        let a_first = store.open_tab(a.id).unwrap().id;
        let a_second = store.open_tab(a.id).unwrap().id;
        let b_only = store.open_tab(b.id).unwrap().id;

        store.close_tab(a_second).unwrap();

        let reopened = store_in(dir.path());
        assert_eq!(listed_active_tab(&reopened, a.id), Some(a_first));
        assert_eq!(listed_active_tab(&reopened, b.id), Some(b_only));
    }
}
