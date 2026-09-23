/**
 * 登录页脚本：调用后端真实接口（SQLite 数据库校验账号密码）
 */
(function () {
  "use strict";

  var form = document.getElementById("loginForm");
  var accountInput = document.getElementById("account");
  var passwordInput = document.getElementById("password");
  var accountError = document.getElementById("accountError");
  var passwordError = document.getElementById("passwordError");
  var submitBtn = document.getElementById("submitBtn");
  var togglePwd = document.getElementById("togglePwd");

  function setError(input, errorEl, message) {
    errorEl.textContent = message || "";
    input.classList.toggle("is-invalid", !!message);
  }

  function clearErrors() {
    setError(accountInput, accountError, "");
    setError(passwordInput, passwordError, "");
  }

  function validate() {
    var ok = true;
    var account = accountInput.value.trim();
    var password = passwordInput.value;
    if (!account) { setError(accountInput, accountError, "请输入账号"); ok = false; }
    else if (account.length < 3) { setError(accountInput, accountError, "账号至少 3 个字符"); ok = false; }
    if (!password) { setError(passwordInput, passwordError, "请输入密码"); ok = false; }
    else if (password.length < 6) { setError(passwordInput, passwordError, "密码至少 6 位"); ok = false; }
    return ok;
  }

  function apiLogin(account, password) {
    var base = window.API_BASE || ""; // 线上（Vercel）由 js/api.js 注入后端地址
    return fetch(base + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account: account, password: password })
    }).then(function (res) {
      return res.json().then(function (data) {
        return { ok: res.ok, data: data };
      });
    });
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    clearErrors();
    if (!validate()) return;

    submitBtn.disabled = true;
    submitBtn.textContent = "登录中…";

    apiLogin(accountInput.value.trim(), passwordInput.value)
      .then(function (result) {
        if (result.ok && result.data.token) {
          localStorage.setItem("auth", JSON.stringify(result.data));
          // 新登录需重新加载教师端 AI 分析：清除历史缓存，保证只有“首次登录”才加载
          ["Report", "Chat"].forEach(function (suffix) {
            ["_v1_", "_v2_", "_v3_"].forEach(function (ver) {
              try {
                localStorage.removeItem("teacherAi" + suffix + ver + result.data.user.account);
              } catch (e) {}
            });
          });
          // 教师角色进入教师端
          if (result.data.user.role === "teacher") {
            window.location.href = "teacher.html";
          } else {
            window.location.href = "home.html";
          }
        } else {
          setError(passwordInput, passwordError, result.data.message || "账号或密码错误");
          submitBtn.disabled = false;
          submitBtn.textContent = "登 录";
        }
      })
      .catch(function () {
        if (window.location.protocol === "file:") {
          setError(passwordInput, passwordError,
            "当前是直接打开文件的方式访问，请通过服务器地址 http://localhost:3123 访问");
        } else {
          setError(passwordInput, passwordError, "网络异常，请稍后再试");
        }
        submitBtn.disabled = false;
        submitBtn.textContent = "登 录";
      });
  });

  accountInput.addEventListener("input", function () { setError(accountInput, accountError, ""); });
  passwordInput.addEventListener("input", function () { setError(passwordInput, passwordError, ""); });

  togglePwd.addEventListener("click", function () {
    var isPwd = passwordInput.type === "password";
    passwordInput.type = isPwd ? "text" : "password";
  });
})();
