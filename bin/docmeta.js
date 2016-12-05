#! /usr/bin/env node

const path = require('path');
const simpleGit= require('simple-git');
const git = simpleGit(__dirname);
const fs = require('fs-extra');
const del = require('del');
const pwd = path.resolve(process.cwd());
const q = require('q');
const argv = require('yargs').argv;


let options = {
    repoURL: "https://github.com/OpherV/Incheon.git",
    deployRepoURL: "https://github.com/OpherV/incheon-docs-site.git",
    buildDocCommand: "npm",
    buildDocCommandArgs: "run docs",
    ignoreTags: ['r0.1.0', 'r0.2.0']
};


const DIRS = {
    out: "docs_out",
    inner_out: "docs-out",
    temp: "docmeta_temp",
    temp_deploy: "docmeta_temp_deploy",
};


let mainGit, deployGit, tempGit;

let docVersions = [];


function cleanup(){
    console.log("cleaning up");

    let deferred = q.defer();

    //cleanup dirs
    fs.removeSync(path.join(pwd, DIRS.out));
    fs.removeSync(path.join(pwd, DIRS.temp));
    fs.removeSync(path.join(pwd, DIRS.temp_deploy));

    //recreate out dir
    fs.mkdirpSync(path.join(pwd, DIRS.out));
    fs.mkdirpSync(path.join(pwd, DIRS.temp));

    deferred.resolve();
    return deferred.promise;
}

function deployDocs(){
    let deferred = q.defer();

    console.log("Deploying docs");
    console.log(`cloning from ${options.deployRepoURL}`);
    mainGit.clone(
        options.deployRepoURL,
        path.join(pwd, DIRS.temp_deploy),
        [],afterClone);

    function afterClone(){
        console.log(`Done cloning`);

        //remove everything but the git
        del.sync(['!'+path.join(DIRS.temp_deploy,'.git/'), path.join(DIRS.temp_deploy,'*') ]);
        del.sync([path.join(DIRS.temp_deploy,'.gitignore')]);
        fs.copySync(path.join(pwd, DIRS.out), path.join(pwd, DIRS.temp_deploy));

        deployGit = simpleGit(path.join(pwd, DIRS.temp_deploy))
            .addConfig('user.name', 'Travis CI')
            .addConfig('user.email', process.env.COMMIT_AUTHOR_EMAIL)
            .add('./*')
            .commit("Autoupdate docs").then(afterCommit);
    }

    function afterCommit(){
        console.log("Done comitting. Pushing");
        deployGit.push();
        deferred.resolve();
    }

    return deferred.promise;
}

function addTravisSSHKey(){
    let deferred = q.defer();
    console.log("adding SSH key");

    let ENCRYPTED_KEY=`encrypted_${process.env.ENCRYPTION_LABEL}_key`;
    let ENCRYPTED_IV=`encrypted_${process.env.ENCRYPTION_LABEL}_key`;

    run_cmd("openssl",["aes-256-cbc", "-K", ENCRYPTED_KEY, "-iv", ENCRYPTED_IV, "-in",
        "deploy_key.enc", "-out", "deploy_key", "-d"], afterOpenSSL);

    function afterOpenSSL(resp){
        console.log(resp);

        fs.chmodSync('deploy_key', '600');
        console.log("running ssh-agent");
        run_cmd("eval",["`ssh-agent -s`"], afterSSHAgent);
    }

    function afterSSHAgent(resp){
        console.log(resp);

        console.log("running ssh-add");
        run_cmd("ssh-add",["deploy_key"], afterSSHAdd);
    }

    function afterSSHAdd(resp){
        console.log(resp);

        deferred.resolve();
    }

    return deferred.promise;
}


let generateRedirectFile = wrapSyncFunctionWithPromise(function(data){
    let redirectVersion = data.latest?data.latest:data.versions[0];

    let redirectTemplate = `<script>document.location='${redirectVersion}/index.html'</script>`;
    fs.writeFileSync(path.join(DIRS.out,'index.html'),redirectTemplate);
});

function generateDocsForAllVersions(){
    let deferred = q.defer();

    mainGit = simpleGit() ;
    tempGit = simpleGit(path.join(pwd, DIRS.temp)) ;

    let promises = [];

    git.tags(function(err,tags){
        //push all tags to be built, except if defined otherwise in the ignoreTags options
        for (let tag of tags.all){
            if (options.ignoreTags.indexOf(tag) == -1) {
                docVersions.push(tag);
            }
        }
        docVersions.push('develop');


        for (let version of docVersions) {
            console.log(`generating docs for version ${version}`);
            let promise = generateDocsForVersion(version).then(function(){
                console.log(`done generating docs for version ${version}`);
            });

            promises.push(promise);
        }

        q.all(promises).then(function(){
            deferred.resolve({
                versions: docVersions,
                latest: tags.latest
            });
        })

    });

    return deferred.promise;
}


function generateDocsForVersion(name){
    let deferred = q.defer();

    let versionPath = getVersionPath(name);

    tempGit.clone(
        options.repoURL,
        path.join(pwd, DIRS.temp, name),
        [
            `--branch`, `${name}`,
            `--depth`, `1`,
            `--single-branch`
        ],afterClone);

    function afterClone(){
        process.chdir(versionPath);
        run_cmd('npm', ['install'], afterNpmInstall);
    }

    function afterNpmInstall(){
        process.chdir(versionPath);
        run_cmd(options.buildDocCommand, ['run', 'docs'], afterBuildDocsCommand)
    }

    function afterBuildDocsCommand(){
        process.chdir(pwd);
        fs.copySync(path.join(versionPath,DIRS.inner_out), path.join(DIRS.out,name));
        deferred.resolve();
    }

    return deferred.promise;
}

function getVersionPath(name){
    return path.join(pwd, DIRS.temp, name);
}


function wrapSyncFunctionWithPromise(func){
    return function(data) {
        let deferred = q.defer();
        q.resolve(func(data));
        return q.promise;
    }
}

function run_cmd(cmd, args, callBack ) {
    let spawn = require('child_process').spawn;
    let child = spawn(cmd, args);
    let resp = "";

    child.stdout.on('data', function (buffer) { resp += buffer.toString() });
    child.stdout.on('end', function() { callBack (resp) });
}



//actual run command

let defer = q.defer();
p = defer.promise;
if (!argv.nocleanup){ p = p.then(cleanup); }
if (argv.travis){ p = p.then(addTravisSSHKey); }
p = p.then(generateDocsForAllVersions);
p = p.then(generateRedirectFile);
if (argv.deploy){ p = p.then(deployDocs); }

defer.resolve();