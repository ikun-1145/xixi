(function(){

function createTerminal(options={}){

  const terminal = document.getElementById(options.terminalId || "terminal");
  const inputEl = document.getElementById(options.inputId || "consoleInput");
  const hiddenInput = document.getElementById(options.hiddenInputId || "hiddenInput");
  const promptText = document.getElementById(options.promptId || "promptText");

  let state = {
    user: options.user || "sunland",
    isRoot: options.isRoot || false,
    path: options.startPath || "~",
    buffer: "",
    cursor: 0,
    history: [],
    historyIndex: -1,
    running: false,
    lastExitCode: 0,
    env: {
      USER: options.user || "sunland",
      HOME: options.isRoot ? "/root" : "/home/sunland",
      SHELL: "/bin/bash",
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    },
    jobs: [],
    jobId: 0,
    bootTime: Date.now()
  };

  const handlers = {};

  /* ===== 基础文件系统（简化版）===== */
  const fs = {
    "/": ["root","home","etc","dev"],
    "/root": ["secret.key","system.log"],
    "/home": ["sunland"],
    "/home/sunland": ["notes.txt","readme.md"],
    "/dev": ["null"]
  };

  function resolvePath(target){

    if(!target){
      return state.env.HOME;
    }

    if(target === "~"){
      return state.env.HOME;
    }

    if(target === ".."){
      if(state.path === "/") return "/";
      const parts = state.path.split("/").filter(Boolean);
      parts.pop();
      return parts.length ? "/" + parts.join("/") : "/";
    }

    if(target.startsWith("~")){
      return target.replace("~", state.env.HOME);
    }

    if(target.startsWith("/")){
      return target;
    }

    return state.path === "/"
      ? "/" + target
      : state.path + "/" + target;
  }

  /* ===== 内置命令 ===== */
  handlers.help = function(){
    printLine("Built-in commands: help ls cd pwd whoami history clear cat sudo alias echo ps top sleep jobs fg kill export exit uname uptime hostname who date id systemctl");
  };

  handlers.pwd = function(){
    printLine(state.path);
  };

  handlers.whoami = function(){
    printLine(state.user);
  };

  handlers.history = function(){
    state.history.forEach((c,i)=>{
      printLine((i+1) + "  " + c);
    });
  };

  handlers.clear = function(){
    const cl = document.getElementById("currentLine");
    terminal.innerHTML = "";
    terminal.appendChild(cl);
  };

  handlers.ls = function(args){
    const dir = state.path;
    const files = fs[dir] || [];

    if(args[0] === "-a"){
      printLine(".  ..  " + files.join("  "));
      return;
    }

    if(args[0] === "-l"){
      files.forEach(f=>{
        const perm = "-rw-r--r--";
        printLine(perm + " 1 " + state.user + " " + state.user + " 1024 Jan 01 00:00 " + f);
      });
      return;
    }

    printLine(files.join("  "));
  };

  handlers.cd = function(args){
    const target = args[0];
    const newPath = resolvePath(target);

    if(newPath === "/root" && !state.isRoot){
      printLine("Permission denied");
      return;
    }

    if(fs[newPath]){
      state.path = newPath;
    }else{
      printLine("cd: no such directory");
    }
  };

  /* ===== hostname 命令 ===== */
  handlers.hostname = function(){
    printLine("hidden-layer");
  };

  /* ===== who 命令 ===== */
  handlers.who = function(){
    printLine(state.user + " tty1 2026-02-27 08:00");
  };

  /* ===== date 命令 ===== */
  handlers.date = function(){
    printLine(new Date().toString());
  };

  /* ===== id 命令 ===== */
  handlers.id = function(){
    if(state.isRoot){
      printLine("uid=0(root) gid=0(root) groups=0(root)");
    } else {
      printLine("uid=1000("+state.user+") gid=1000("+state.user+") groups=1000("+state.user+")");
    }
  };
  /* ===== uname 命令 ===== */
handlers.uname = function(args){
  if(args[0] === "-a"){
    printLine("Linux hidden-layer 6.8.0-virtual #1 SMP PREEMPT_DYNAMIC x86_64 GNU/Linux");
  } else {
    printLine("Linux");
  }
};
/* ===== uptime 命令 ===== */
handlers.uptime = function(){
  const seconds = Math.floor((Date.now() - state.bootTime)/1000);
  const mins = Math.floor(seconds/60);
  const secs = seconds % 60;
  printLine("up " + mins + " minutes, " + secs + " seconds");
};

  /* ===== cat 命令 ===== */
  handlers.cat = function(args){
    if(args[0] === "/etc/passwd"){
      printLine("root:x:0:0:root:/root:/bin/bash");
      printLine("sunland:x:1000:1000::/home/sunland:/bin/bash");
      return;
    }

    if(args[0] === "/etc/hostname"){
      printLine("hidden-layer");
      return;
    }
    if(args[0] === "/proc/cpuinfo"){
  printLine("processor\t: 0");
  printLine("vendor_id\t: GenuineIntel");
  printLine("model name\t: HiddenLayer Virtual CPU @ 3.40GHz");
  printLine("cpu cores\t: 4");
  printLine("flags\t\t: fpu vme de pse tsc msr pae mce cx8 apic sep mtrr");
  return;
}

if(args[0] === "/proc/meminfo"){
  printLine("MemTotal:       8192000 kB");
  printLine("MemFree:        2048000 kB");
  printLine("MemAvailable:   4096000 kB");
  printLine("Buffers:         256000 kB");
  printLine("Cached:         1024000 kB");
  return;
}

    if(args[0] === "/proc/uptime"){
      const seconds = Math.floor((Date.now() - state.bootTime) / 1000);
      printLine(seconds + ".00 " + seconds + ".00");
      return;
    }
    const file = args[0];
    const dir = state.path;
    if(!file){ printLine("cat: missing file operand"); return; }
    if(dir === "/root" && !state.isRoot){
      printLine("Permission denied");
      return;
    }
    const files = fs[dir] || [];
    if(files.includes(file)){
      printLine("[content of " + file + "]");
    }else{
      printLine("cat: " + file + ": No such file");
    }
  };

  /* ===== sudo 命令（临时提权）===== */
  handlers.sudo = function(args){
    if(state.isRoot){
      execute(args);
      return;
    }
    if(args[0] === "su"){
      handlers.su();
      return;
    }
    printLine("sudo: permission denied (simulation)");
  };

  /* ===== alias 命令 ===== */
  state.aliases = {};
  handlers.alias = function(args){
    const raw = args.join(" ");
    if(!raw.includes("=")){
      printLine("alias: usage alias name='command'");
      return;
    }
    const [name,cmd] = raw.split("=");
    state.aliases[name.trim()] = cmd.replace(/'/g,"").trim();
  };

  /* ===== export 命令 ===== */
  handlers.export = function(args){
    const raw = args.join(" ");
    if(!raw.includes("=")){
      printLine("export: usage export VAR=value");
      state.lastExitCode = 1;
      return;
    }
    const [k,v] = raw.split("=");
    state.env[k.trim()] = v.trim();
    state.lastExitCode = 0;
  };

  /* ===== exit 命令 ===== */
  handlers.exit = function(){
    printLine("logout");
    state.lastExitCode = 0;
  };

  /* ===== echo 命令（支持简单 $(cmd)）===== */
  handlers.echo = function(args){
    let text = args.join(" ");

    // 简单 $(...) 解析（不支持嵌套）
    const subMatch = text.match(/\$\(([^)]+)\)/);
    if(subMatch){
      const subCmd = subMatch[1].trim().split(" ");
      const originalPrint = printLine;
      let captured = "";

      // 临时劫持输出
      printLine = function(t){ captured += t; };
      execute(subCmd);
      printLine = originalPrint;

      text = text.replace(subMatch[0], captured);
    }

    printLine(text);
  };

  /* ===== ps 命令（假进程表）===== */
  handlers.ps = function(){
    printLine("  PID TTY          TIME CMD");
    printLine("    1 tty1     00:00:00 systemd");
    printLine("   42 tty1     00:00:00 snapd");
    printLine("  101 tty1     00:00:00 bash");
    printLine("  202 tty1     00:00:00 hidden-layer");
  };

  /* ===== top 命令（实时刷新，可 Ctrl+C 退出）===== */
  handlers.top = function(){
    if(state.running) return;
    state.running = true;

    function renderTop(){
      if(!state.running) return;
      handlers.clear();
      printLine("top - hidden-layer simulation");
      printLine("Tasks: 4 total, 1 running");
      printLine("CPU: " + Math.floor(Math.random()*40+10) + "%");
      printLine("MEM: " + Math.floor(Math.random()*60+20) + "%");
      printLine("");
      printLine("  PID  COMMAND");
      printLine("    1  systemd");
      printLine("   42  snapd");
      printLine("  101  bash");
      printLine("  202  hidden-layer");
      setTimeout(renderTop,1000);
    }

    renderTop();
  };

  /* ===== sleep 命令 ===== */
  handlers.sleep = function(args){
    const sec = parseInt(args[0] || "1",10);
    if(isNaN(sec)){ printLine("sleep: invalid time"); return; }
    state.running = true;
    setTimeout(()=>{
      state.running = false;
      state.lastExitCode = 0;
      updatePrompt();
      renderInput();
    }, sec*1000);
  };

  /* ===== jobs 命令 ===== */
  handlers.jobs = function(){
    state.jobs.forEach(j=>{
      printLine("["+j.id+"] " + j.cmd);
    });
  };

  handlers.fg = function(args){
    const id = parseInt(args[0], 10);
    const job = state.jobs.find(j => j.id === id);
    if(!job){
      printLine("fg: job not found");
      state.lastExitCode = 1;
      return;
    }
    state.running = true;
    execute(job.cmd.split(" "));
    state.jobs = state.jobs.filter(j => j.id !== id);
    state.lastExitCode = 0;
  };

  handlers.kill = function(args){
    const id = parseInt(args[0], 10);
    const job = state.jobs.find(j => j.id === id);
    if(!job){
      printLine("kill: job not found");
      state.lastExitCode = 1;
      return;
    }
    state.jobs = state.jobs.filter(j => j.id !== id);
    printLine("["+id+"] terminated");
    state.lastExitCode = 0;
  };
  /* ===== systemctl ===== */
handlers.systemctl = function(args){
  if(args[0] === "status"){
    printLine("● hidden-layer.service - Hidden Layer Core");
    printLine("   Loaded: loaded (/etc/systemd/system/hidden-layer.service; enabled)");
    printLine("   Active: active (running)");
    printLine("   Main PID: 202 (hidden-layer)");
    return;
  }
  printLine("systemctl: unsupported operation");
};

  /* ===== 权限控制 ===== */
  handlers.su = function(){
    state.awaitingPassword = true;
    state._passwordBuffer = "";
    printLine("Password:");
  };

  function updatePrompt(){
    let displayPath = state.path;

    if(displayPath === state.env.HOME){
      displayPath = "~";
    } else if(displayPath.startsWith(state.env.HOME + "/")){
      displayPath = "~" + displayPath.slice(state.env.HOME.length);
    }

    promptText.textContent =
      state.user + "@hidden-layer:" + displayPath + (state.isRoot?"#":"$") + " ";
  }

  function renderInput(){
    const before = state.buffer.slice(0,state.cursor);
    const after = state.buffer.slice(state.cursor);
    if(after.length>0){
      inputEl.innerHTML = before +
        '<span class="cursor-char">'+after[0]+'</span>'+after.slice(1);
    } else {
      inputEl.innerHTML = before + '<span class="cursor-block"> </span>';
    }
  }

  function printLine(text){
    const p=document.createElement("p");
    p.textContent=text;
    const cl=document.getElementById("currentLine");
    terminal.insertBefore(p,cl);
    terminal.scrollTop=terminal.scrollHeight;
  }

  function registerCommand(name,fn){
    handlers[name]=fn;
  }

  function execute(parts){
    if(parts[0] === "!!"){
      if(state.history.length === 0){
        printLine("No commands in history");
        state.lastExitCode = 1;
        return;
      }
      const last = state.history[state.history.length - 1];
      printLine(promptText.textContent + last);
      execute(last.split(" "));
      return;
    }

    if(parts[0] && parts[0].startsWith("!")){
      const index = parseInt(parts[0].slice(1), 10) - 1;
      if(!isNaN(index) && state.history[index]){
        const cmd = state.history[index];
        printLine(promptText.textContent + cmd);
        execute(cmd.split(" "));
      } else {
        printLine("event not found");
        state.lastExitCode = 1;
      }
      return;
    }

    // 简单管道支持：cmd1 | cmd2
    const pipeIndex = parts.indexOf("|");
    if(pipeIndex !== -1){
      const left = parts.slice(0, pipeIndex);
      const right = parts.slice(pipeIndex + 1);

      let buffer = "";
      const originalPrint = printLine;
      printLine = function(t){ buffer += t + "\n"; };

      execute(left);

      printLine = originalPrint;

      if(right.length > 0){
        // 将左侧输出作为参数拼接到右侧命令
        execute(right.concat(buffer.trim().split(/\s+/)));
      }
      return;
    }

    // 处理逻辑运算符
    const full = parts.join(" ");
    if(full.includes("&&") || full.includes("||")){
      const andSplit = full.split("&&");
      if(andSplit.length>1){
        execute(andSplit[0].trim().split(" "));
        if(state.lastExitCode===0){
          execute(andSplit.slice(1).join("&&").trim().split(" "));
        }
        return;
      }
      const orSplit = full.split("||");
      if(orSplit.length>1){
        execute(orSplit[0].trim().split(" "));
        if(state.lastExitCode!==0){
          execute(orSplit.slice(1).join("||").trim().split(" "));
        }
        return;
      }
    }

    // 处理后台任务
    if(parts[parts.length-1] === "&"){
      parts.pop();
      const cmdCopy = parts.join(" ");
      const id = ++state.jobId;
      state.jobs.push({id, cmd: cmdCopy});
      printLine("["+id+"] " + cmdCopy);
      setTimeout(()=>{
        execute(cmdCopy.split(" "));
        state.jobs = state.jobs.filter(j=>j.id!==id);
      },10);
      return;
    }

    // 变量替换
    parts = parts.map(p=>{
      if(p === "$?") return String(state.lastExitCode);
      if(p === "$RANDOM") return String(Math.floor(Math.random()*32768));
      if(p.startsWith("$")){
        const key = p.slice(1);
        if(state.env[key] !== undefined){
          return state.env[key];
        }
      }
      return p;
    });

    const cmd=parts[0];
    const args=parts.slice(1);

    // 简单输出重定向
    const redirectIndex = args.indexOf(">");
    let redirectFile = null;
    if(redirectIndex !== -1){
      redirectFile = args[redirectIndex+1];
      args.splice(redirectIndex);
    }

    if(!cmd) return;

    if(handlers[cmd]){
      let originalPrint = null;
      let buffer = "";

      if(redirectFile === "/dev/null"){
        originalPrint = printLine;
        printLine = function(){};
      } else if(redirectFile){
        originalPrint = printLine;
        printLine = function(t){ buffer += t + "\n"; };
      }

      handlers[cmd](args);

      if(redirectFile){
        printLine = originalPrint;
        if(redirectFile !== "/dev/null") {
          if(!fs[state.path]) fs[state.path] = [];
          if(!fs[state.path].includes(redirectFile)){
            fs[state.path].push(redirectFile);
          }
        }
      }
      // 删除 state.lastExitCode = 0;，让 handler 自己决定
    }else{
      printLine(parts[0] + ": command not found");
      state.lastExitCode = 127;
    }
  }

  hiddenInput.addEventListener("keydown",e=>{
    if(e.ctrlKey && e.key === "c"){
      if(state.running){
        state.running = false;
        printLine("^C");
        updatePrompt();
        renderInput();
      }
      return;
    }

    e.preventDefault();

    if(e.key.length===1 && !e.ctrlKey && !e.metaKey){
      state.buffer=
        state.buffer.slice(0,state.cursor)+
        e.key+
        state.buffer.slice(state.cursor);
      state.cursor++;
      renderInput();
      return;
    }

    if(e.key==="Backspace" && state.cursor>0){
      state.buffer=
        state.buffer.slice(0,state.cursor-1)+
        state.buffer.slice(state.cursor);
      state.cursor--;
      renderInput();
      return;
    }

    if(e.key==="ArrowLeft" && state.cursor>0){
      state.cursor--;
      renderInput();
      return;
    }

    if(e.key==="ArrowRight" && state.cursor<state.buffer.length){
      state.cursor++;
      renderInput();
      return;
    }

    if(e.key==="Enter"){
      if(state.awaitingPassword){
        const pwd = state.buffer.trim();
        state.awaitingPassword = false;
        state.buffer = "";
        state.cursor = 0;

        if(pwd === "sunland"){
          state.user = "root";
          state.isRoot = true;
          state.path = "/root";
          printLine("root access granted");
        }else{
          printLine("Authentication failed");
        }

        updatePrompt();
        renderInput();
        return;
      }

      const cmd = state.buffer.trim();

      if(cmd!==""){
        state.history.push(cmd);
        printLine(promptText.textContent + cmd);
        execute(cmd.split(" "));
      }

      state.buffer = "";
      state.cursor = 0;

      // 如果刚刚执行的是 su，并且 execute 内部已设置 awaitingPassword，
      // 则不要立即刷新 prompt（避免 Password 下方出现新 prompt）
      if(!state.awaitingPassword){
        updatePrompt();
        renderInput();
      }

      return;
    }
  });

  updatePrompt();
  renderInput();
  hiddenInput.focus();

  /* ============================= */
/* ===== 拟真增强 Phase 2 ===== */
/* ============================= */

/* ===== 简易权限模型 ===== */
const permissions = {};

Object.keys(fs).forEach(dir=>{
  fs[dir].forEach(name=>{
    const full = dir === "/" ? "/" + name : dir + "/" + name;
    permissions[full] = {
      owner: state.user,
      mode: "644"
    };
  });
});

/* ===== chmod ===== */
handlers.chmod = function(args){
  const mode = args[0];
  const file = args[1];

  if(!mode || !file){
    printLine("chmod: usage chmod MODE FILE");
    state.lastExitCode = 1;
    return;
  }

  const full = state.path === "/" ? "/" + file : state.path + "/" + file;

  if(!permissions[full]){
    printLine("chmod: cannot access '" + file + "'");
    state.lastExitCode = 1;
    return;
  }

  permissions[full].mode = mode;
  state.lastExitCode = 0;
};

/* ===== rm ===== */
handlers.rm = function(args){
  const file = args[0];
  if(!file){
    printLine("rm: missing operand");
    state.lastExitCode = 1;
    return;
  }

  const files = fs[state.path] || [];

  if(!files.includes(file)){
    printLine("rm: cannot remove '" + file + "'");
    state.lastExitCode = 1;
    return;
  }

  fs[state.path] = files.filter(f=>f!==file);

  const full = state.path === "/" ? "/" + file : state.path + "/" + file;
  delete permissions[full];

  state.lastExitCode = 0;
};

/* ===== tree ===== */
handlers.tree = function(){
  function walk(dir, prefix=""){
    const files = fs[dir] || [];
    files.forEach((f,i)=>{
      const isLast = i === files.length-1;
      const connector = isLast ? "└── " : "├── ";
      printLine(prefix + connector + f);

      const sub = dir === "/" ? "/" + f : dir + "/" + f;

      if(fs[sub]){
        walk(sub, prefix + (isLast ? "    " : "│   "));
      }
    });
  }

  printLine(state.path);
  walk(state.path);
};

/* ===== 覆盖 ls -l 显示真实权限 ===== */
const _originalLs = handlers.ls;

handlers.ls = function(args){
  if(args[0] === "-l"){
    const dir = state.path;
    const files = fs[dir] || [];

    files.forEach(f=>{
      const full = dir === "/" ? "/" + f : dir + "/" + f;
      const meta = permissions[full];

      let perm = "-rw-r--r--";

      if(meta){
        perm = "-r" + meta.mode[0] + meta.mode[1] + meta.mode[2] + "r--";
      }

      printLine(perm + " 1 " + state.user + " " + state.user +
        " 1024 Jan 01 00:00 " + f);
    });

    return;
  }

  _originalLs(args);
};
/* ===== mkdir（自动权限记录）===== */
handlers.mkdir = function(args){
  const name = args[0];
  if(!name){
    printLine("mkdir: missing operand");
    state.lastExitCode = 1;
    return;
  }

  const newPath = state.path === "/" ? "/" + name : state.path + "/" + name;

  if(fs[newPath]){
    printLine("mkdir: File exists");
    state.lastExitCode = 1;
    return;
  }

  fs[newPath] = [];
  if(!fs[state.path]) fs[state.path] = [];
  fs[state.path].push(name);

  // 确保同步权限
  permissions[newPath] = {
    owner: state.user,
    mode: "755"
  };

  state.lastExitCode = 0;
};

/* ===== which（模拟 PATH 查找）===== */
handlers.which = function(args){
  const cmd = args[0];
  if(!cmd){
    printLine("which: missing argument");
    state.lastExitCode = 1;
    return;
  }

  if(handlers[cmd]){
    printLine("/usr/bin/" + cmd);
    state.lastExitCode = 0;
  } else {
    printLine(cmd + " not found");
    state.lastExitCode = 1;
  }
};

/* ===== chown（模拟）===== */
handlers.chown = function(args){
  const user = args[0];
  const file = args[1];

  if(!user || !file){
    printLine("chown: usage chown USER FILE");
    state.lastExitCode = 1;
    return;
  }

  const full = state.path === "/" ? "/" + file : state.path + "/" + file;

  if(!permissions[full]){
    printLine("chown: cannot access '" + file + "'");
    state.lastExitCode = 1;
    return;
  }

  permissions[full].owner = user;
  state.lastExitCode = 0;
};
/* ===== 更新 help ===== */
handlers.help = function(){
  printLine("Built-in commands:");
  printLine("help ls cd pwd whoami history clear cat sudo alias echo");
  printLine("ps top sleep jobs fg kill export exit uname uptime");
  printLine("hostname who date id systemctl chmod rm tree");
  printLine("mkdir which chown");
};

/* ===== touch（生成权限记录）===== */
handlers.touch = function(args){
  const name = args[0];
  if(!name){
    printLine("touch: missing file operand");
    state.lastExitCode = 1;
    return;
  }
  if(!fs[state.path]) fs[state.path] = [];
  if(!fs[state.path].includes(name)){
    fs[state.path].push(name);
  }
  // 新增权限记录
  const full = state.path === "/" ? "/" + name : state.path + "/" + name;
  permissions[full] = {
    owner: state.user,
    mode: "644"
  };
  state.lastExitCode = 0;
};

/* ============================= */
/* ===== 拟真增强结束 ===== */
/* ============================= */
  return {
    registerCommand,
    printLine,
    state,
    execute,
    handlers,
    resolvePath,
    fs,
    updatePrompt,
    renderInput
  };
}

window.createTerminal=createTerminal;

})();