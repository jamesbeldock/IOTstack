const BuildController = ({ server, settings, version, logger }) => {
  const BuildsService = require('../services/builds');
  const ZipService = require('../services/zip');
  const TemplatesController = require('./templates');
  const { getDirectoryList, getFileList, emptyDirectory } = require('../utils/fsUtils');
  const { formatDate } = require('../utils/date');
  const { getUniqueNetworkListFromServices } = require('../utils/networkUtils');
  const buildInstallerGenerator = require('../../templates/scripts/build_installer');
  const retr = {};

  const buildsService = BuildsService({ server, settings, version, logger });
  const zipService = ZipService({ server, settings, version, logger });
  const templatesController = TemplatesController({ server, settings, version, logger });
  const path = require('path');
  const fs = require('fs');

  retr.init = () => {
    templatesController.init();
    buildsService.init();
    zipService.init();
    logger.debug('BuildController:init()');
  };

  retr.buildStack = async ({ host, buildOptions }) => {
    return new Promise(async (resolve, reject) => {
      try {
        outputStack = {
          services: {},
          networks: {}
        };
        const currentDate = formatDate();
        const toZip = [];
        const prebuildScripts = [];
        const postbuildScripts = [];

        const failedStack = {
          services: [],
          networks: []
        };

        // Get service templates for processing and output
        const serviceTemplatePromises = [];

        buildOptions.selectedServices.forEach((selectedService) => {
          serviceTemplatePromises.push(templatesController.getServiceTemplateAsJson(selectedService));
        });

        await Promise.allSettled(serviceTemplatePromises).then((serviceTemplateResults) => {
          serviceTemplateResults.forEach((servicePromiseResult) => {
            if (servicePromiseResult.status === 'fulfilled' && servicePromiseResult.value) {
              const serviceName = Object.keys(servicePromiseResult.value)[0];
              outputStack.services[serviceName] = servicePromiseResult.value[serviceName];
            } else {
              failedStack.services.push(servicePromiseResult);
            }
          });
          return outputStack;
        });

        const podNetworks = getUniqueNetworkListFromServices({ services: outputStack.services, logger });

        // Get network templates for processing and output
        const networkTemplatePromises = [];

        podNetworks.forEach((networkName) => {
          networkTemplatePromises.push(templatesController.getNetworkTemplateAsJson(networkName));
        });

        await Promise.allSettled(networkTemplatePromises).then((networkTemplateResults) => {
          networkTemplateResults.forEach((networkPromiseResult) => {
            if (networkPromiseResult.status === 'fulfilled' && networkPromiseResult.value) {
              const networkName = Object.keys(networkPromiseResult.value)[0];
              outputStack.networks[networkName] = networkPromiseResult.value[networkName];
            } else {
              failedStack.networks.push(networkPromiseResult);
            }
          });
          return outputStack;
        });

        if (failedStack.services.length > 0 || failedStack.networks.length > 0) {
          console.warn('Failed to compile some templates: ', failedStack);
        }

        // All templates gathered and ready for processing by each service.
        const templatesBuildLogic = [];
        const {
          localBuildsDirectory,
          buildInstallerFilePostfix,
          localTemplatesPath,
          localNetworksRelativePath,
          localServicesRelativePath,
          buildLogicFile,
          buildDockerFilePostfix,
          buildOptionsFilePostfix,
          localTmpPath
        } = settings.paths;

        emptyDirectory(localTmpPath, ['.gitignore']);

        const servicesBuildPath = path.join(localTemplatesPath, localServicesRelativePath);
        const networksBuildPath = path.join(localTemplatesPath, localNetworksRelativePath);

        // Instantiate each service's build logic
        Object.keys(outputStack.services).forEach((serviceName) => {
          const serviceBuildScript = path.join(servicesBuildPath, serviceName, buildLogicFile);
          if (fs.existsSync(serviceBuildScript)) {
            templatesBuildLogic.push(require(serviceBuildScript)({ settings, version, logger }));
          } else {
            console.log(`BuildController::buildStack: No service build file for '${serviceName}'. Looking in: '${serviceBuildScript}'`)
          }
        });

        // Instantiate each network's build logic
        Object.keys(outputStack.networks).forEach((networkName) => {
          const networkBuildScript = path.join(networksBuildPath, networkName, buildLogicFile);
          if (fs.existsSync(networkBuildScript)) {
            templatesBuildLogic.push(require(networkBuildScript)({ settings, version, logger }));
          } else {
            console.log(`BuildController::buildStack: No network build file for '${networkName}'. Looking in: '${networkBuildScript}'`)
          }
        });

        const issueList = {
          services: [],
          networks: [],
          other: []
        };

        await templatesBuildLogic.reduce((prom, buildLogic) => {
          return prom.then(async () => {
            if (typeof buildLogic.build === 'function') {
              await buildLogic.build({
                outputTemplateJson: outputStack,
                buildOptions,
                tmpPath: localTmpPath,
                fileTimePrefix: currentDate,
                zipList: toZip,
                prebuildScripts,
                postbuildScripts
              });
              // .then((res) => {
              //   console.log('Result: ', res);
              // });
            }

            if (typeof buildLogic.issues === 'function') {
              return buildLogic.issues({
                outputTemplateJson: outputStack,
                buildOptions,
                tmpPath: localTmpPath
              }).then((issueResults) => {
                if (Array.isArray(issueResults) && issueResults.length > 0) {
                  issueResults.forEach((issue) => {
                    if (issue.type === 'service') {
                      issueList.services.push(issue);
                    } else if (issue.type === 'network') {
                      issueList.networks.push(issue);
                    } else {
                      issueList.other.push(issue);
                    }
                  });
                }
              });
            }

            return Promise.resolve({});
          });
        }, Promise.resolve()).then(() => {
          console.debug('BuildController::buildStack: Build Completed');
        }).catch((err) => {
          console.error('BuildController::buildStack: Build Error: ', err);
          return reject({
            component: 'BuildController::buildStack',
            message: 'Unhandled error occured',
            error: JSON.parse(JSON.stringify(err, Object.getOwnPropertyNames(err)))
          });
        });

        const { yamlFilename, yamlOutputFilePath } = await buildsService.saveBuildYaml({ buildJson: outputStack, fileTimePrefix: currentDate });
        const { jsonFilename, jsonOutputFilePath } = await buildsService.saveBuildOptions({ buildOptionsJson: buildOptions, fileTimePrefix: currentDate });
        const dockerComposeBaseFilename = buildDockerFilePostfix.split('_')[1];
        const buildInstallerFileBaseFilename = buildInstallerFilePostfix.split('_')[1];
        const buildOptionsBaseFilename = buildOptionsFilePostfix.split('_')[1];

        buildInstallerFilePostfix
        const buildInstallerContents = await buildInstallerGenerator({
          options: {
            build: currentDate,
            prebuildScripts,
            postbuildScripts
          },
          logger,
          version
        });

        const installerScriptFilename = `${currentDate}${buildInstallerFilePostfix}`;
        const installerOutputFilePath = path.join(localBuildsDirectory, installerScriptFilename);

        fs.writeFileSync(installerOutputFilePath, buildInstallerContents.data);

        toZip.push({
          fullPath: installerOutputFilePath,
          zipName: buildInstallerFileBaseFilename
        });

        toZip.push({
          fullPath: yamlOutputFilePath,
          zipName: dockerComposeBaseFilename
        });

        toZip.push({
          fullPath: jsonOutputFilePath,
          zipName: buildOptionsBaseFilename
        });

        const zipDirectories = [];
        toZip.forEach((zipEntries) => {
          if (Array.isArray(zipEntries.directories) && zipEntries.directories.length > 0) {
            zipEntries.directories.forEach((directory) => {
              zipDirectories.push(directory);
            });
          }
        });

        const zipResults = await zipService.zipFiles({ fileList: toZip, fileTimePrefix: currentDate, archiveDirectoryList: zipDirectories });

        return resolve({
          issueList,
          build: currentDate,
          host,
          files: {
            yamlFilename,
            jsonFilename,
            zipFilename: zipResults.zipFilename
          }
        });

      } catch (err) {
        console.log(err);
        console.trace();
        return reject({
          component: 'BuildController::buildStack',
          message: 'Unhandled error occured',
          error: JSON.parse(JSON.stringify(err, Object.getOwnPropertyNames(err)))
        });
      }
    });
  };

  retr.checkIssues = ({ buildOptions }) => {
    return new Promise(async (resolve, reject) => {
      try {
        outputStack = {
          services: {},
          networks: {}
        };

        const failedStack = {
          services: [],
          networks: []
        };

        // Get service templates for processing and output
        const serviceTemplatePromises = [];

        buildOptions.selectedServices.forEach((selectedService) => {
          serviceTemplatePromises.push(templatesController.getServiceTemplateAsJson(selectedService));
        });

        await Promise.allSettled(serviceTemplatePromises).then((serviceTemplateResults) => {
          serviceTemplateResults.forEach((servicePromiseResult) => {
            if (servicePromiseResult.status === 'fulfilled' && servicePromiseResult.value) {
              const serviceName = Object.keys(servicePromiseResult.value)[0];
              outputStack.services[serviceName] = servicePromiseResult.value[serviceName];
            } else {
              failedStack.services.push(servicePromiseResult);
            }
          });
          return outputStack;
        });

        const podNetworks = getUniqueNetworkListFromServices({ services: outputStack.services, logger });

        // Get network templates for processing and output
        const networkTemplatePromises = [];

        podNetworks.forEach((networkName) => {
          networkTemplatePromises.push(templatesController.getNetworkTemplateAsJson(networkName));
        });

        await Promise.allSettled(networkTemplatePromises).then((networkTemplateResults) => {
          networkTemplateResults.forEach((networkPromiseResult) => {
            if (networkPromiseResult.status === 'fulfilled' && networkPromiseResult.value) {
              const networkName = Object.keys(networkPromiseResult.value)[0];
              outputStack.networks[networkName] = networkPromiseResult.value[networkName];
            } else {
              failedStack.networks.push(networkPromiseResult);
            }
          });
          return outputStack;
        });

        if (failedStack.services.length > 0 || failedStack.networks.length > 0) {
          console.warn('Failed to compile some templates: ', failedStack);
        }

        // All templates gathered and ready for processing by each service.
        const templatesBuildLogic = [];
        const {
          localTemplatesPath,
          localNetworksRelativePath,
          localServicesRelativePath,
          buildLogicFile
        } = settings.paths;
        const servicesBuildPath = path.join(localTemplatesPath, localServicesRelativePath);
        const networksBuildPath = path.join(localTemplatesPath, localNetworksRelativePath);

        // Instantiate each service's build logic
        Object.keys(outputStack.services).forEach((serviceName) => {
          const serviceBuildScript = path.join(servicesBuildPath, serviceName, buildLogicFile);
          if (fs.existsSync(serviceBuildScript)) {
            templatesBuildLogic.push(require(serviceBuildScript)({ settings, version, logger }));
          } else {
            console.log(`BuildController::checkIssues: No service build file for '${serviceName}'. Looking in: '${serviceBuildScript}'`)
          }
        });

        // Instantiate each network's build logic
        Object.keys(outputStack.networks).forEach((networkName) => {
          const networkBuildScript = path.join(networksBuildPath, networkName, buildLogicFile);
          if (fs.existsSync(networkBuildScript)) {
            templatesBuildLogic.push(require(networkBuildScript)({ settings, version, logger }));
          } else {
            console.log(`BuildController::checkIssues: No network build file for '${networkName}'. Looking in: '${networkBuildScript}'`)
          }
        });

        const issueList = {
          services: [],
          networks: [],
          other: []
        };

        // Compile service options to JSON output
        for (let i = 0; i < templatesBuildLogic.length; i++) {
          await templatesBuildLogic[i].compile({
            outputTemplateJson: outputStack,
            buildOptions,
          });
        }

        await Promise.allSettled(networkTemplatePromises).then((networkTemplateResults) => {
          networkTemplateResults.forEach((networkPromiseResult) => {
            if (networkPromiseResult.status === 'fulfilled' && networkPromiseResult.value) {
              const networkName = Object.keys(networkPromiseResult.value)[0];
              outputStack.networks[networkName] = networkPromiseResult.value[networkName];
            } else {
              failedStack.networks.push(networkPromiseResult);
            }
          });
          return outputStack;
        });

        return templatesBuildLogic.reduce((prom, buildLogic) => {
          return prom.then(() => {
            if (typeof buildLogic.issues === 'function') {
              return buildLogic.issues({
                outputTemplateJson: outputStack,
                buildOptions
              }).then((issueResults) => {
                if (Array.isArray(issueResults) && issueResults.length > 0) {
                  issueResults.forEach((issue) => {
                    if (issue.type === 'service') {
                      issueList.services.push(issue);
                    } else if (issue.type === 'network') {
                      issueList.networks.push(issue);
                    } else {
                      issueList.other.push(issue);
                    }
                  });
                }
              });
            }

            return Promise.resolve({ issueList });
          });
        }, Promise.resolve()).then(() => {
          console.debug('BuildController::checkIssues: Issue check completed');
          return resolve({ issueList });
        }).catch((err) => {
          console.error('BuildController::checkIssues: Issue check error: ', err);
          return reject({ issueList });
        });
      } catch (err) {
        console.log(err);
        console.trace();
        return reject({
          component: 'BuildController::checkIssues',
          message: 'Unhandled error occured',
          error: JSON.parse(JSON.stringify(err, Object.getOwnPropertyNames(err)))
        });
      }
    });
  };

  retr.getPreviousBuildsList = ({ host, buildTime }) => {
    return new Promise(async (resolve, reject) => {
      try {
        const {
          localBuildsDirectory,
          buildDockerFilePostfix,
          buildOptionsFilePostfix,
          buildZipFilePostfix
        } = settings.paths;

        const buildFiles = getFileList(localBuildsDirectory);

        const buildsList = {};
        let singleBuild = {};

        buildFiles.forEach((fileName) => {
          const deconstructedFilename = fileName.split('_');
          if (deconstructedFilename.length === 2) {
            const checkBuildTime = deconstructedFilename[0];
            if (typeof buildsList[checkBuildTime] === 'undefined') {
              buildsList[checkBuildTime] = {};
            }

            if (fileName.endsWith(buildDockerFilePostfix)) {
              if (!buildTime) {
                buildsList[checkBuildTime] = {
                  ...buildsList[checkBuildTime],
                  yaml: fileName
                }
              } else {
                if (checkBuildTime === buildTime) {
                  singleBuild = {
                    ...singleBuild,
                    yaml: fileName
                  }
                }
              }
            }
  
            if (fileName.endsWith(buildOptionsFilePostfix)) {
              if (!buildTime) {
                buildsList[checkBuildTime] = {
                  ...buildsList[checkBuildTime],
                  json: fileName
                }
              } else {
                if (checkBuildTime === buildTime) {
                  singleBuild = {
                    ...singleBuild,
                    json: fileName
                  }
                }
              }
            }
  
            if (fileName.endsWith(buildZipFilePostfix)) {
              if (!buildTime) {
                buildsList[checkBuildTime] = {
                  ...buildsList[checkBuildTime],
                  zip: fileName
                }
              } else {
                if (checkBuildTime === buildTime) {
                  singleBuild = {
                    ...singleBuild,
                    zip: fileName
                  }
                }
              }
            }
          }
        });
        if (!buildTime) {
          return resolve({ buildsList, host });
        } else {
          return resolve({ buildFiles: singleBuild, host });
        }
      } catch (err) {
        console.log(err);
        console.trace();
        return reject({
          component: 'BuildController::getPreviousBuildsList',
          message: 'Unhandled error occured',
          error: JSON.parse(JSON.stringify(err, Object.getOwnPropertyNames(err)))
        });
      }
    });
  };

  retr.downloadPreviousBuildsList = ({ host, buildTime, type }) => {
    return new Promise(async (resolve, reject) => {
      try {
        if (!buildTime) {
          return reject({
            component: 'BuildController::downloadPreviousBuildsList',
            message: 'No build time specified'
          });
        }

        if (!type) {
          return reject({
            component: 'BuildController::downloadPreviousBuildsList',
            message: 'No download type specified'
          });
        }

        const {
          localBuildsDirectory,
          buildDockerFilePostfix,
          buildZipFilePostfix,
          buildOptionsFilePostfix,
          buildInstallerFilePostfix
        } = settings.paths;

        const buildFiles = getFileList(localBuildsDirectory);

        let singleBuild = {
          otherFiles: []
        };

        buildFiles.forEach((fileName) => {
          if (fileName.startsWith(buildTime)) {
            if (fileName.endsWith(buildDockerFilePostfix)) {
              singleBuild['yaml'] = fileName;
            } else if (fileName.endsWith(buildZipFilePostfix)) {
              singleBuild['zip'] = fileName;
            } else if (fileName.endsWith(buildOptionsFilePostfix)) {
              singleBuild['json'] = fileName;
            } else if (fileName.endsWith(buildInstallerFilePostfix)) {
              singleBuild['installer'] = fileName;
            } else {
              singleBuild.otherFiles.push(fileName);
            }
          }
        });

        if (type === 'yaml' || type === 'yml') {
          const fullPath = path.join(localBuildsDirectory, singleBuild['yaml']);
          const filename = buildDockerFilePostfix.substring(1); // Removes the prefixed underscope _ on filename
          return resolve({ fullPath, filename, path: localBuildsDirectory });
        }

        if (type === 'json') {
          const fullPath = path.join(localBuildsDirectory, singleBuild['json']);
          const filename = buildOptionsFilePostfix.substring(1); // Removes the prefixed underscope _ on filename
          return resolve({ fullPath, filename, path: localBuildsDirectory });
        }

        if (type === 'zip') {
          const fullPath = path.join(localBuildsDirectory, singleBuild['zip']);
          const filename = buildZipFilePostfix.substring(1); // Removes the prefixed underscope _ on filename
          return resolve({ fullPath, filename, path: localBuildsDirectory });
        }

        if (type === 'sh' || type === 'bash' || type === 'bootstrap') {
          const fullPath = path.join(localBuildsDirectory, singleBuild['bootstrap']);
          const filename = buildInstallerFilePostfix.substring(1); // Removes the prefixed underscope _ on filename
          return resolve({ fullPath, filename, path: localBuildsDirectory });
        }

        return reject({
          component: 'BuildController::downloadPreviousBuildsList',
          message: `Unknown type '${type}'`
        });
      } catch (err) {
        console.log(err);
        console.trace();
        return reject({
          component: 'BuildController::downloadPreviousBuildsList',
          message: 'Unhandled error occured',
          error: JSON.parse(JSON.stringify(err, Object.getOwnPropertyNames(err)))
        });
      }
    });
  };

  return retr;
}
module.exports = BuildController;